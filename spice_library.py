"""Portable subset of self-contained ngspice subcircuit libraries."""
from pathlib import Path
import re


NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]*", re.ASCII)
MODEL_NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", re.ASCII)
NODE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.+-]*", re.ASCII)
BODY_ARITY = {"R": 4, "C": 4, "L": 4, "V": 4, "I": 4, "E": 6, "G": 6, "F": 5, "H": 5}
MODEL_PORTS = {
    "D": ("D", ("A", "K")), "NPN": ("Q", ("C", "B", "E")), "PNP": ("Q", ("C", "B", "E")),
    "NMOS": ("M", ("D", "G", "S", "B")), "PMOS": ("M", ("D", "G", "S", "B")),
    "VDMOS": ("M", ("D", "G", "S")), "NJF": ("J", ("D", "G", "S")),
    "PJF": ("J", ("D", "G", "S")), "SW": ("S", ("+", "-", "CTRL+", "CTRL-")),
}
MODEL_CARD = re.compile(r"\.model\s+(\S+)\s+([a-z]\w*)\s*(.*)", re.I | re.ASCII)
PARAMETER = re.compile(r"([A-Za-z]\w*)\s*=\s*([^\s,()]+)|([A-Za-z]\w*)", re.ASCII)


def model_statement(name, model, parse_number):
    family = model["type"]
    if not MODEL_NAME.fullmatch(name) or family not in MODEL_PORTS:
        raise ValueError(f"Unsupported model name or family: {name}")
    flags = model["flags"]
    if flags and (family != "VDMOS" or flags not in (["NCHAN"], ["PCHAN"])):
        raise ValueError(f"{name}: unsupported model options")
    for key, value in model["parameters"].items():
        if not NAME.fullmatch(key):
            raise ValueError(f"{name}: invalid model parameter {key}")
        parse_number(value)
    params = " ".join(f"{key}={value}" for key, value in model["parameters"].items())
    body = " ".join([*flags, params]).strip()
    return f".model {name} {family}" + (f" ({body})" if body else "")


def parse_model(line, parse_number):
    match = MODEL_CARD.fullmatch(line)
    if match is None:
        raise ValueError("Malformed .MODEL statement")
    name, family, body = match.groups()
    model = {"type": family.upper(), "parameters": {}, "flags": []}
    offset = 0
    for token in PARAMETER.finditer(body):
        if body[offset:token.start()].strip(" \t,()"):
            raise ValueError(f"{name}: unsupported parameter expression")
        key, value, flag = token.groups()
        if flag:
            model["flags"].append(flag.upper())
        elif key.upper() != "MFG":
            model["parameters"][key.upper()] = value
        offset = token.end()
    if body[offset:].strip(" \t,()"):
        raise ValueError(f"{name}: unsupported parameter expression")
    model_statement(name.upper(), model, parse_number)
    return name.upper(), model


def validate_subcircuit(name, ports, body, parse_number, parameters=None):
    if (not MODEL_NAME.fullmatch(name) or not 1 <= len(ports) <= 16
            or len({pin.casefold() for pin in ports}) != len(ports)
            or any(not NODE.fullmatch(pin) or pin == "0" for pin in ports)):
        raise ValueError(f"{name}: expected 1–16 distinct, non-ground ports")
    if not body:
        raise ValueError(f"{name}: subcircuit has no elements")
    parameters = parameters or {}
    for key, value in parameters.items():
        if not NAME.fullmatch(key):
            raise ValueError(f"{name}: invalid subcircuit parameter")
        parse_number(value)
    declared = {key.upper() for key in parameters}
    local_models = {}
    for line in body:
        if "\n" in line or "\r" in line:
            raise ValueError(f"{name}: invalid element line")
        if line.lower().startswith(".model "):
            key, model = parse_model(line, parse_number)
            if key in local_models:
                raise ValueError(f"{name}: duplicate local model {key}")
            local_models[key] = model
    seen = set()
    for line in body:
        if line.lower().startswith(".model "):
            continue
        fields = line.split()
        if not fields:
            raise ValueError(f"{name}: invalid element line")
        ref = fields[0].upper()
        if len(fields) == 5 and ref[0] in "VI" and fields[3].lower() == "dc":
            fields.pop(3)
        kind = ref[0]
        model = local_models.get(fields[-1].upper()) if kind in "DQMJS" else None
        required = BODY_ARITY.get(kind)
        if model:
            primitive, pins = MODEL_PORTS[model["type"]]
            required = len(pins)+2 if primitive == kind else None
        if (not NAME.fullmatch(ref) or ref in seen or len(fields) != required
                or any(not NODE.fullmatch(node) for node in fields[1:-1])):
            raise ValueError(f"{name}: unsupported element {fields[0]}")
        seen.add(ref)
        if model:
            continue
        token = fields[-1]
        if token.startswith("{") and token.endswith("}") and declared:
            expression = token[1:-1]
            terms = re.findall(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[a-zA-Z]*|[a-zA-Z]\w*|[-+*/()]", expression)
            if "".join(terms) != expression or not terms:
                raise ValueError(f"{name}: unsupported parameter expression")
            for term in terms:
                if term not in "-+*/()" and term.upper() not in declared:
                    parse_number(term)
            continue
        value = parse_number(token)
        if kind in "RCL" and value <= 0:
            raise ValueError(f"{name}: passive element values must be positive")


def read_library(path: Path, parse_number):
    with path.open(encoding="utf-8-sig", errors="replace") as file:
        source = file.read(2_000_001)
    if len(source) > 2_000_000:
        raise ValueError("SPICE library exceeds the import size limit")
    entries, models, issues = {}, {}, []
    name = None
    lines = []
    for raw in source.splitlines():
        line = raw.split(";", 1)[0].strip()
        if not line or line.startswith("*"):
            continue
        if line.startswith("+"):
            if not lines:
                raise ValueError("Continuation before the first library statement")
            lines[-1] += " " + line[1:].strip()
        else:
            lines.append(line)
    for line in lines:
        fields = line.split()
        command = fields[0].lower()
        if command == ".subckt" and name is None and len(fields) >= 3:
            name, ports, body = fields[1].upper(), fields[2:], []
            parameters = {}
            separator = next((i for i, field in enumerate(ports) if field.lower() == "params:"), None)
            if separator is not None:
                arguments = ports[separator+1:]
                ports = ports[:separator]
                for item in arguments:
                    key, _, value = item.partition("=")
                    parameters[key] = value
        elif command == ".ends" and name is not None:
            try:
                if len(fields) > 2 or (len(fields) == 2 and fields[1].upper() != name):
                    raise ValueError(f"{name}: mismatched .ENDS")
                validate_subcircuit(name, ports, body, parse_number, parameters)
                if name in entries:
                    raise ValueError(f"Duplicate subcircuit {name}")
                entries[name] = {"ports": ports, "body": body}
                if parameters:
                    entries[name]["parameters"] = parameters
            except ValueError as error:
                issues.append(str(error))
            name = None
        elif name is not None:
            body.append(line)
        elif command == ".model":
            try:
                key, model = parse_model(line, parse_number)
                if key in models and models[key] != model:
                    raise ValueError(f"Duplicate model {key}")
                models[key] = model
            except ValueError as error:
                issues.append(str(error))
        elif command != ".end":
            issues.append(f"Skipped unsupported statement {fields[0]}")
    if name is not None:
        issues.append(f"{name}: missing .ENDS")
    if not (entries or models):
        raise ValueError(issues[0] if issues else "No supported SPICE model or subcircuit definitions")
    return models, entries, issues


def read_subcircuits(path: Path, parse_number):
    _, entries, issues = read_library(path, parse_number)
    if issues or not entries:
        raise ValueError(issues[0] if issues else "Expected one or more complete .SUBCKT definitions")
    return entries
