"""Versioned schematic, connectivity compiler and SPICE export."""
from collections import Counter
from dataclasses import asdict, dataclass, field
from dataclasses import replace
import json
import math
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from qucs_library import PARAMETERS
from spice_library import MODEL_PORTS, model_statement, validate_subcircuit


SYMBOLS = {
    "R": ("Resistor", "1k"), "C": ("Capacitor", "1u"), "L": ("Inductor", "1m"),
    "V": ("Voltage source", "DC 5"), "I": ("Current source", "DC 1m"),
    "D": ("Diode", "DDEFAULT"), "G": ("Ground", ""), "N": ("Net label", "out"),
    "X": ("SPICE subcircuit", ""),
    "Q": ("Bipolar transistor", ""), "M": ("MOSFET", ""), "J": ("JFET", ""),
    "S": ("Voltage-controlled switch", ""),
}
GENERIC_MODELS = {
    "GENERIC_NPN": ("NPN", {"IS": "1e-14", "BF": "100"}),
    "GENERIC_PNP": ("PNP", {"IS": "1e-14", "BF": "100"}),
    "GENERIC_NMOS": ("NMOS", {"LEVEL": "1", "VTO": "1", "KP": "1m"}),
    "GENERIC_PMOS": ("PMOS", {"LEVEL": "1", "VTO": "-1", "KP": "1m"}),
    "GENERIC_NJFET": ("NJF", {"VTO": "-2", "BETA": "1m"}),
    "GENERIC_PJFET": ("PJF", {"VTO": "2", "BETA": "1m"}),
    "GENERIC_SWITCH": ("SW", {"VT": "1", "VH": "0.1", "RON": "1", "ROFF": "1g"}),
}
MODELED_SYMBOLS = frozenset("QMJS")
TRANSISTOR_PINS = ((1, -2), (-2, 0), (1, 2))
SWITCH_PINS = ((-2, -1), (2, -1), (-1, 2), (1, 2))
SUFFIXES = {"t": 1e12, "g": 1e9, "meg": 1e6, "k": 1e3, "m": 1e-3,
            "u": 1e-6, "n": 1e-9, "p": 1e-12, "f": 1e-15, "": 1}
WAVE_FIELDS = {
    "SIN": ("Offset", "Amplitude", "Frequency (Hz)", "Delay (s)", "Damping (1/s)", "Phase (°)"),
    "PULSE": ("Low", "High", "Delay (s)", "Rise (s)", "Fall (s)", "Width (s)", "Period (s)"),
    "EXP": ("Initial", "Pulsed", "Rise delay (s)", "Rise time constant (s)",
            "Fall delay (s)", "Fall time constant (s)"),
    "PWL": ("Time/value pairs",),
}
SOURCE_DEFAULTS = {"DC": "DC 5", "AC": "DC 0 AC 1 0", "SIN": "SIN 0 1 1k 0 0 0",
                   "PULSE": "PULSE 0 1 0 1u 1u 500u 1m",
                   "EXP": "EXP 0 1 0 100u 1m 100u", "PWL": "PWL 0 0 1m 1 2m 0"}


def number(token):
    match = re.fullmatch(r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(meg|[tgkmunpf])?",
                         token, re.I | re.ASCII)
    if not match:
        raise ValueError(f"Invalid SPICE number {token!r}")
    value = float(match[1]) * SUFFIXES[(match[2] or "").lower()]
    if not math.isfinite(value):
        raise ValueError(f"Nonfinite SPICE number {token!r}")
    return value


@dataclass
class Part:
    ref: str
    kind: str
    x: int
    y: int
    value: str
    rotation: int = 0
    port_names: list[str] = field(default_factory=list)
    legacy_pin_layout: bool = False

    def pins(self):
        if self.kind == "X" or self.legacy_pin_layout:
            offsets = self.box_offsets()
        elif self.kind in MODELED_SYMBOLS:
            offsets = self.device_offsets()
        else:
            offsets = ((0, 0),) if self.kind in "GN" else ((-2, 0), (2, 0))
        result = []
        for x, y in offsets:
            for _ in range(self.rotation % 4):
                x, y = -y, x
            result.append((self.x + x, self.y + y))
        return result

    def device_offsets(self):
        if self.kind == "S":
            return SWITCH_PINS
        if self.kind == "M" and len(self.port_names) == 4:
            return (*TRANSISTOR_PINS, (3, 0))
        return TRANSISTOR_PINS

    def box_offsets(self):
        split = (len(self.port_names)+1)//2
        return [(-3, 2*i-split+1) for i in range(split)] + [
            (3, 2*i-(len(self.port_names)-split)+1) for i in range(len(self.port_names)-split)]


@dataclass
class Profile:
    mode: str = "OP"
    step: str = "10u"
    stop: str = "5m"
    start_hz: str = "10"
    stop_hz: str = "100k"
    points: int = 50
    sweep_source: str = "V1"
    sweep_start: str = "0"
    sweep_stop: str = "10"
    sweep_step: str = "1"

    def directive(self):
        if self.mode == "OP":
            return ".op"
        if self.mode == "DC":
            source = self.sweep_source.upper()
            if not re.fullmatch(r"[VI][A-Z0-9_]+", source, re.ASCII):
                raise ValueError("DC sweep needs a voltage or current source reference")
            start, stop, step = map(number, (self.sweep_start, self.sweep_stop, self.sweep_step))
            if not step or not 0 < (stop-start)/step <= 100000:
                raise ValueError("DC sweep step must reach the stop value within 100000 steps")
            return f".dc {source} {self.sweep_start} {self.sweep_stop} {self.sweep_step}"
        if self.mode == "TRAN":
            if not 0 < number(self.step) <= number(self.stop):
                raise ValueError("Transient step must be positive and no greater than stop time")
            return f".tran {self.step} {self.stop} 0 {self.step}"
        if self.mode == "AC":
            if not 0 < number(self.start_hz) < number(self.stop_hz) or not 1 <= self.points <= 10000:
                raise ValueError("AC needs increasing positive frequencies and 1–10000 points per decade")
            return f".ac dec {self.points} {self.start_hz} {self.stop_hz}"
        raise ValueError(f"Unknown analysis {self.mode}")


@dataclass
class Project:
    parts: list[Part] = field(default_factory=list)
    wires: list[tuple] = field(default_factory=list)
    junctions: list[tuple] = field(default_factory=list)
    profiles: dict[str, Profile] = field(default_factory=lambda: {
        "Operating point": Profile(), "AC sweep": Profile("AC"), "Transient": Profile("TRAN")})
    active: str = "Operating point"
    diode_models: dict[str, tuple[str, str]] = field(
        default_factory=lambda: {"DDEFAULT": ("1e-14", "1")})
    qucs_models: dict[str, dict[str, str]] = field(default_factory=dict)
    subcircuits: dict[str, dict] = field(default_factory=dict)
    device_models: dict[str, dict] = field(default_factory=lambda: {
        name: {"type": family, "parameters": parameters.copy(), "flags": []}
        for name, (family, parameters) in GENERIC_MODELS.items()})
    markers: list[dict] = field(default_factory=list)

    def register_qucs_diode(self, entry):
        stem = "QUCS_" + re.sub(r"[^A-Z0-9_]", "_", entry.name.upper())[:80]
        name = stem
        index = 2
        while name in self.diode_models or name in self.device_models or (name in self.qucs_models
                                            and self.qucs_models[name] != entry.parameters):
            name = f"{stem}_{index}"
            index += 1
        qucs_diode_model(name, entry.parameters)
        self.qucs_models[name] = entry.parameters.copy()
        return name

    def add(self, kind, point):
        used = {part.ref for part in self.parts}
        index = 1
        while f"{kind}{index}" in used:
            index += 1
        self.parts.append(Part(f"{kind}{index}", kind, *point, SYMBOLS[kind][1]))

    def add_profile(self, name, mode, copy_active=False):
        name = name.strip()
        if not name or any(name.casefold() == key.casefold() for key in self.profiles):
            raise ValueError("Enter a unique profile name")
        profile = replace(self.profiles[self.active]) if copy_active else Profile(mode)
        profile.directive()
        self.profiles[name] = profile
        self.active = name

    def remove_active_profile(self):
        if len(self.profiles) == 1:
            raise ValueError("Keep at least one simulation profile")
        del self.profiles[self.active]
        self.active = next(iter(self.profiles))

    def dump(self):
        return json.dumps({"version": 2, **asdict(self)}, indent=2)

    @classmethod
    def load(cls, source):
        data = json.loads(source)
        version = data.pop("version", None)
        if version not in (1, 2):
            raise ValueError("Unsupported project version")
        data["parts"] = [Part(**entry) for entry in data["parts"]]
        data["wires"] = [tuple(map(tuple, wire)) for wire in data["wires"]]
        data["junctions"] = list(map(tuple, data["junctions"]))
        data["profiles"] = {key: Profile(**value) for key, value in data["profiles"].items()}
        project = cls(**data)
        if (project.active not in project.profiles
                or any(p.kind not in SYMBOLS or type(p.x) is not int or type(p.y) is not int
                       or type(p.rotation) is not int or not isinstance(p.value, str)
                       or type(p.legacy_pin_layout) is not bool
                       or (p.legacy_pin_layout and p.kind not in MODELED_SYMBOLS)
                       or not isinstance(p.ref, str) for p in project.parts)
                or any(len(wire) != 2 or wire[0] == wire[1] for wire in project.wires)
                or any(len(point) != 2 or any(type(axis) is not int for axis in point)
                       for point in [*project.junctions, *(p for w in project.wires for p in w)])):
            raise ValueError("Invalid project geometry, active profile, or symbol")
        for profile in project.profiles.values():
            profile.directive()
        for name, (current, emission) in project.diode_models.items():
            diode_model(name, current, emission)
        for name, parameters in project.qucs_models.items():
            qucs_diode_model(name, parameters)
        for name, model in project.subcircuits.items():
            validate_subcircuit(name, model["ports"], model["body"], number, model.get("parameters"))
        for name, model in project.device_models.items():
            if name in project.diode_models or name in project.qucs_models:
                raise ValueError(f"Duplicate model name: {name}")
            model_statement(name, model, number)
        for part in project.parts:
            if part.kind == "X" and part.port_names != project.subcircuits[part.value]["ports"]:
                raise ValueError(f"{part.ref}: subcircuit port order changed")
            if part.kind in "QMJS":
                model = project.device_models.get(part.value.upper())
                if not model or (part.kind, tuple(part.port_names)) != MODEL_PORTS[model["type"]]:
                    raise ValueError(f"{part.ref}: device model or port order changed")
        for marker in project.markers:
            if marker.get("kind") == "I":
                if not isinstance(marker.get("ref"), str) or type(marker.get("pin")) is not int:
                    raise ValueError("Invalid current marker")
                continue
            points = marker.get("points", [])
            if (marker.get("kind") not in ("V", "VD")
                    or len(points) != (2 if marker["kind"] == "VD" else 1)
                    or any(len(p) != 2 or any(type(v) is not int for v in p) for p in points)):
                raise ValueError("Invalid voltage marker")
        if version == 1:
            project.preserve_connected_legacy_pins()
        return project

    def preserve_connected_legacy_pins(self):
        devices = [part for part in self.parts if part.kind in MODELED_SYMBOLS]
        if not devices:
            return
        for part in devices:
            part.legacy_pin_layout = True
        occupied = Counter(pin for part in self.parts for pin in part.pins())
        anchors = set(self.junctions)
        anchors.update(tuple(point) for marker in self.markers if marker["kind"] != "I"
                       for point in marker["points"])
        for part in devices:
            old_pins = part.pins()
            occupied.subtract(old_pins)
            part.legacy_pin_layout = False
            if any(occupied[point] or point in anchors or any(on_wire(point, wire) for wire in self.wires)
                   for point in (*old_pins, *part.pins())):
                part.legacy_pin_layout = True
            occupied.update(part.pins())

    def save(self, path):
        path = Path(path)
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
            temp = Path(file.name)
            try:
                file.write(self.dump())
                file.close()
                temp.replace(path)
            finally:
                temp.unlink(missing_ok=True)


def on_wire(point, wire):
    (x, y), ((ax, ay), (bx, by)) = point, wire
    return ((x-ax)*(by-ay) == (y-ay)*(bx-ax)
            and min(ax, bx) <= x <= max(ax, bx) and min(ay, by) <= y <= max(ay, by))


def connectivity(project):
    parent = {}

    def find(point):
        parent.setdefault(point, point)
        while parent[point] != point:
            parent[point] = parent[parent[point]]
            point = parent[point]
        return point

    def join(a, b):
        parent[find(b)] = find(a)

    points = {point for part in project.parts for point in part.pins()}
    points.update(point for wire in project.wires for point in wire)
    points.update(project.junctions)
    for point in sorted(points):
        find(point)
    for wire in project.wires:
        for point in sorted(points):
            if on_wire(point, wire):
                join(wire[0], point)
    labels = {}
    for part in project.parts:
        if part.kind in "GN":
            name = "0" if part.kind == "G" else part.value.lower()
            if not re.fullmatch(r"[a-z_][a-z0-9_]*|0", name, re.ASCII):
                raise ValueError(f"{part.ref}: invalid net label")
            point = part.pins()[0]
            join(labels.setdefault(name, point), point)
    names = {}
    for name, point in labels.items():
        root = find(point)
        if root in names and names[root] != name:
            raise ValueError(f"Conflicting net labels {names[root]} and {name}")
        names[root] = name
    used = set(labels)
    for index, root in enumerate(sorted({find(point) for point in points}), 1):
        name = f"n{index}"
        while name in used:
            name += "_"
        names.setdefault(root, name)
    return {point: names[find(point)] for point in points}


def source_tokens(value):
    return value.replace("(", " ").replace(")", " ").replace(",", " ").split()


def source_value(value):
    tokens = source_tokens(value)
    if not tokens:
        raise ValueError("Source value is empty")
    if len(tokens) == 1:
        number(tokens[0])
        return "DC " + tokens[0]
    index, clauses = 0, []
    for clause in ("DC", "AC"):
        if index < len(tokens) and tokens[index].upper() == clause:
            first = index
            index += 1
            value = number(tokens[index] if index < len(tokens) else "")
            index += 1
            if clause == "AC" and value < 0:
                raise ValueError("AC magnitude must be nonnegative")
            if clause == "AC" and index < len(tokens) and tokens[index].upper() not in WAVE_FIELDS:
                number(tokens[index])
                index += 1
            clauses.append(" ".join(tokens[first:index]))
    if index < len(tokens) and tokens[index].upper() in WAVE_FIELDS:
        mode = tokens[index].upper()
        arguments = tokens[index+1:]
        values = list(map(number, arguments))
        if mode == "PWL":
            times = values[::2]
            if len(values) < 4 or len(values) % 2 or times[0] < 0 or any(a >= b for a, b in zip(times, times[1:])):
                raise ValueError("PWL needs at least two time/value pairs with increasing nonnegative times")
        elif len(values) != len(WAVE_FIELDS[mode]):
            raise ValueError(f"{mode} requires {', '.join(WAVE_FIELDS[mode])}")
        elif mode == "SIN" and (values[2] <= 0 or min(values[3:5]) < 0):
            raise ValueError("SIN frequency must be positive, with nonnegative delay and damping")
        elif mode == "PULSE" and (min(values[2:6]) < 0 or values[-1] <= 0):
            raise ValueError("PULSE timing must be nonnegative with a positive period")
        elif mode == "EXP" and (not 0 <= values[2] <= values[4] or min(values[3], values[5]) <= 0):
            raise ValueError("EXP needs ordered nonnegative delays and positive time constants")
        clauses.append(f"{mode}({' '.join(arguments)})")
        index = len(tokens)
    if index != len(tokens):
        raise ValueError("Use DC, AC, SIN, PULSE, EXP, or PWL source parameters")
    return " ".join(clauses)


def diode_model(name, current, emission):
    if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name, re.ASCII):
        raise ValueError("Use an uppercase SPICE model name")
    if min(number(current), number(emission)) <= 0:
        raise ValueError("Diode model saturation current and emission coefficient must be positive")
    return f".model {name} D(IS={current} N={emission})"


def qucs_diode_model(name, parameters):
    if (not re.fullmatch(r"[A-Z][A-Z0-9_]*", name, re.ASCII)
            or parameters.keys() - PARAMETERS or not {"IS", "N"} <= parameters.keys()):
        raise ValueError("Invalid Qucs-S diode model")
    for value in parameters.values():
        number(value)
    if min(number(parameters["IS"]), number(parameters["N"])) <= 0:
        raise ValueError("Diode model saturation current and emission coefficient must be positive")
    fields = " ".join(f"{key}={parameters[key]}" for key in sorted(parameters))
    return f".model {name} D({fields})"


def translate_selection(project, selected_parts, selected_wires, selected_junctions, dx, dy):
    def shifted(point):
        return point[0]+dx, point[1]+dy

    before = connectivity(project)
    old_nets = [before[pin] for part in project.parts for pin in part.pins()]
    wires = list(project.wires)
    moving_wires = [w for i, w in enumerate(wires) if i in selected_wires]
    fixed_wires = [w for i, w in enumerate(wires) if i not in selected_wires]
    moving = {pin for i in selected_parts for pin in project.parts[i].pins()}
    moving.update(pin for wire in moving_wires for pin in wire)
    moving.update(project.junctions[i] for i in selected_junctions)
    fixed = {pin for i, part in enumerate(project.parts) if i not in selected_parts for pin in part.pins()}
    fixed.update(pin for wire in fixed_wires for pin in wire)
    fixed.update(p for i, p in enumerate(project.junctions) if i not in selected_junctions)
    contacts = {p for p in moving if p in fixed or any(on_wire(p, wire) for wire in fixed_wires)}
    contacts.update(p for p in fixed if any(on_wire(p, wire) for wire in moving_wires))
    for i in selected_parts:
        part = project.parts[i]
        part.x, part.y = shifted((part.x, part.y))
    for i in selected_wires:
        project.wires[i] = tuple(shifted(pin) for pin in wires[i])
    for i in selected_junctions:
        project.junctions[i] = shifted(project.junctions[i])
    existing = {frozenset(wire) for wire in project.wires}
    for start in sorted(contacts):
        end = shifted(start)
        bend = end[0], start[1]
        for a, b in ((start, bend), (bend, end)):
            key = frozenset((a, b))
            if a != b and key not in existing:
                project.wires.append((a, b))
                existing.add(key)
    after = connectivity(project)
    new_nets = [after[pin] for part in project.parts for pin in part.pins()]
    pairs = set(zip(old_nets, new_nets))
    if (len(pairs) != len(set(old_nets)) or len(pairs) != len(set(new_nets))
            or any((a == "0") != (b == "0") for a, b in pairs)):
        raise ValueError("This move would change electrical connectivity. Edit the nearby wires first.")
    for marker in project.markers:
        if marker["kind"] != "I":
            marker["points"] = [
                list(shifted(p)) if tuple(p) in moving or any(on_wire(p, w) for w in moving_wires) else p
                for p in marker["points"]]


def marker_node(point, project, nodes):
    point = tuple(point)
    if point in nodes:
        return nodes[point]
    candidates = {nodes[wire[0]] for wire in project.wires if on_wire(point, wire)}
    if len(candidates) == 1:
        return candidates.pop()
    raise ValueError(f"Marker at {point} needs an unambiguous wire or pin")


def netlist(project, measurements=None):
    nodes = connectivity(project)
    devices = sorted((p for p in project.parts if p.kind not in "GN"), key=lambda p: p.ref.upper())
    if not devices or "0" not in nodes.values():
        raise ValueError("Place electrical components and connect a ground reference")
    neighbors = {}
    refs, models, pin_counts = set(), set(), {}
    subcircuits = set()
    lines = ["CircuitBench"]
    by_ref = {p.ref.upper(): p for p in devices}
    used_names = set(by_ref)
    used_nodes = set(nodes.values())
    sensors = {}
    for index, marker in enumerate(project.markers, 1):
        if marker["kind"] == "I":
            ref, pin = marker["ref"].upper(), marker["pin"]
            if ref not in by_ref or not 0 <= pin < len(by_ref[ref].pins()):
                raise ValueError(f"Current marker needs an existing pin on {ref}")
            if (ref, pin) not in sensors:
                tag = f"cwb{index}"
                while f"V_{tag.upper()}" in used_names or f"n_{tag}" in used_nodes:
                    tag += "_"
                sensor, inner = f"V_{tag}", f"n_{tag}"
                used_names.add(sensor.upper())
                used_nodes.add(inner)
                sensors[ref, pin] = sensor, inner
            sensor, _ = sensors[ref, pin]
            if measurements is not None:
                measurements.append((f"I({ref}:{pin+1})", f"i({sensor.lower()})", None))
        else:
            nets = [marker_node(point, project, nodes) for point in marker["points"]]
            args = [f"v({node})" for node in nets]
            if measurements is not None:
                measurements.append((" − ".join(args), args[0], args[1] if len(args) == 2 else None))
    for part in devices:
        ref = part.ref.upper()
        if ref in refs or not re.fullmatch(part.kind + r"[A-Z0-9_]+", ref, re.ASCII):
            raise ValueError(f"Invalid or duplicate designator {part.ref}")
        refs.add(ref)
        terminals = [nodes[pin] for pin in part.pins()]
        if part.kind in "RCLVID" and terminals[0] == terminals[1]:
            raise ValueError(f"{ref}: both pins are on the same net")
        for node in terminals:
            pin_counts.setdefault(node, []).append(ref)
            neighbors.setdefault(node, set()).update(terminals)
        value = part.value.strip()
        if part.kind in "RCL":
            if number(value) <= 0:
                raise ValueError(f"{ref}: value must be positive")
        elif part.kind in "VI":
            value = source_value(value)
        elif part.kind == "X":
            if value not in project.subcircuits or part.port_names != project.subcircuits[value]["ports"]:
                raise ValueError(f"{ref}: unknown subcircuit or mismatched port order")
            subcircuits.add(value)
        elif value.upper() in project.device_models or part.kind in "QMJS":
            value = value.upper()
            model = project.device_models.get(value)
            ports = ("A", "K") if part.kind == "D" else tuple(part.port_names)
            if not model or (part.kind, ports) != MODEL_PORTS[model["type"]]:
                raise ValueError(f"{ref}: incompatible model or pin order")
            models.add(model_statement(value, model, number))
        else:
            value = value.upper()
            if value in project.qucs_models:
                models.add(qucs_diode_model(value, project.qucs_models[value]))
            elif value in project.diode_models:
                models.add(diode_model(value, *project.diode_models[value]))
            else:
                raise ValueError(f"{ref}: unknown diode model {value}")
        for pin, terminal in enumerate(terminals):
            if (ref, pin) in sensors:
                sensor, inner = sensors[ref, pin]
                lines.append(f"{sensor} {terminal} {inner} 0")
                terminals[pin] = inner
        lines.append(" ".join([ref, *terminals, value]))
    reached, pending = {"0"}, ["0"]
    while pending:
        for node in neighbors.get(pending.pop(), set()) - reached:
            reached.add(node)
            pending.append(node)
    if neighbors.keys() - reached:
        raise ValueError("Circuit contains a group of devices disconnected from ground")
    for node, endpoints in pin_counts.items():
        if node != "0" and len(endpoints) == 1:
            raise ValueError(f"{endpoints[0]}: dangling terminal on {node}")
    profile = project.profiles[project.active]
    directive = profile.directive()
    if profile.mode == "DC" and profile.sweep_source.upper() not in refs:
        raise ValueError(f"DC sweep source {profile.sweep_source} is missing from the schematic")
    definitions = []
    for name in sorted(subcircuits):
        model = project.subcircuits[name]
        parameters = model.get("parameters", {})
        validate_subcircuit(name, model["ports"], model["body"], number, parameters)
        defaults = ["params:", *(f"{key}={value}" for key, value in parameters.items())] if parameters else []
        definitions.extend([" ".join([".subckt", name, *model["ports"], *defaults]),
                            *model["body"], f".ends {name}"])
    return "\n".join([*lines, *sorted(models), *definitions, directive, ".end", ""])


def example():
    project = Project()
    project.parts = [
        Part("V1", "V", -6, 0, "DC 10 AC 1", 1),
        Part("R1", "R", 0, -2, "1k"), Part("R2", "R", 5, 0, "1k", 1),
        Part("N1", "N", 5, -2, "out"), Part("G1", "G", -6, 2, ""),
    ]
    project.wires = [((-6, -2), (-2, -2)), ((2, -2), (5, -2)), ((-6, 2), (5, 2))]
    return project
