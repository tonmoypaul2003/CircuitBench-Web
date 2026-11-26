"""Evaluate numeric expressions over simulation samples."""
import ast
import cmath
import math
import operator
import re


def _power(base, exponent):
    if abs(exponent) > 100:
        raise ValueError("Exponent out of range")
    return base ** exponent


FUNCTIONS = {
    "abs": abs, "mag": abs, "real": lambda z: z.real, "imag": lambda z: z.imag,
    "phase": lambda z: math.degrees(cmath.phase(z)),
    "log": cmath.log, "ln": cmath.log, "loge": cmath.log, "log10": cmath.log10,
    "db": lambda z: 20 * math.log10(abs(z)), "sqrt": cmath.sqrt,
    "exp": cmath.exp, "sin": cmath.sin, "cos": cmath.cos, "pow": _power,
    "multiply": operator.mul,
}
OPERATORS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
             ast.Div: operator.truediv, ast.Pow: _power}
SIGNAL_CALL = re.compile(r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b([vi])\(\s*([\w.#-]+)\s*\)''', re.I)


def evaluate(expression, plot):
    if not 0 < len(expression) <= 500:
        raise ValueError("Enter an expression of up to 500 characters")
    # SPICE node names such as "in" and "net-1" are valid signal names,
    # even though they are not valid Python identifiers.
    expression = SIGNAL_CALL.sub(
        lambda match: f"trace({f'{match[1]}({match[2]})'!r})" if match[1] else match[0],
        expression,
    )
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as error:
        raise ValueError("Invalid expression") from error
    names = {name.casefold(): index for index, name in enumerate(plot.names)}

    def signal(name):
        if name.casefold() not in names:
            raise ValueError(f"Unknown signal {name!r}")
        index = names[name.casefold()]
        return lambda row: row[index]

    def compile_node(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            value = complex(node.value)
            if math.isfinite(value.real):
                return lambda row: value
        if isinstance(node, ast.Name):
            return signal(node.id)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            operand = compile_node(node.operand)
            sign = -1 if isinstance(node.op, ast.USub) else 1
            return lambda row: sign * operand(row)
        if isinstance(node, ast.BinOp) and type(node.op) in OPERATORS:
            left, right = compile_node(node.left), compile_node(node.right)
            operation = OPERATORS[type(node.op)]
            return lambda row: operation(left(row), right(row))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            name = node.func.id.lower()
            if name in ("trace", "v", "i") and len(node.args) == 1:
                key = node.args[0]
                if isinstance(key, ast.Name) and name != "trace":
                    return signal(f"{name}({key.id})")
                if isinstance(key, ast.Constant) and type(key.value) in (str, int):
                    return signal(str(key.value) if name == "trace" else f"{name}({key.value})")
            if name in FUNCTIONS and len(node.args) == (2 if name in ("pow", "multiply") else 1):
                function = FUNCTIONS[name]
                args = [compile_node(arg) for arg in node.args]
                return lambda row: function(*(arg(row) for arg in args))
        raise ValueError("Use signal names, numeric operators, and supported plot functions")

    operation = compile_node(tree.body)
    samples = []
    valid = False
    for row in plot.rows:
        try:
            value = complex(operation(row))
            if not math.isfinite(value.real) or not math.isfinite(value.imag):
                raise ValueError("Nonfinite result")
        except (ArithmeticError, ValueError):
            value = complex(math.nan, math.nan)
        else:
            valid = True
        samples.append(value)
    if not valid:
        raise ValueError("The expression has no finite samples")
    return samples
