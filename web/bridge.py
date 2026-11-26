"""Browser adapter for CircuitBench's shared Python core."""
from dataclasses import asdict
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory

from circuit import (Project, Profile, SYMBOLS, SOURCE_DEFAULTS, connectivity,
                     example, netlist, number, on_wire, source_value, translate_selection)
from spice_library import MODEL_PORTS, read_library
from qucs_library import LibraryDiode, import_diodes
from results import Plot, analysis_deck, bias_deck, bias_readings, load_plot, trim_bias_vectors
from plot_math import evaluate


def view(project):
    return {"project": json.loads(project.dump()),
            "pins": [part.pins() for part in project.parts]}


def action(call):
    op = call["op"]
    if op == "init":
        return {"parts": SYMBOLS, "sources": SOURCE_DEFAULTS, "ports": MODEL_PORTS,
                **view(example())}
    if op == "example":
        project = Project() if call["name"] == "blank" else example()
        if call["name"] in ("ac", "transient"):
            load = project.parts[2]
            load.kind, load.ref, load.value = "C", "C1", "1u"
            if call["name"] == "ac":
                project.parts[0].value = "DC 0 AC 1 0"
                project.active = "AC sweep"
            else:
                project.parts[0].value = "PULSE 0 1 0 1n 1n 10m 20m"
                project.active = "Transient"
        return view(project)
    if op == "waveform":
        with TemporaryDirectory() as directory:
            path = Path(directory) / "result.raw"
            path.write_text(call["raw"], encoding="ascii")
            plot = load_plot(path)
        selected = plot.marker_columns(call.get("measurements", []))
        annotations = None
        if call.get("operating_point") and len(plot.rows) == 1:
            annotations = bias_readings(plot, call["operating_point"])
            selected = trim_bias_vectors(plot, call["operating_point"], selected)
        return {"title": plot.title, "names": plot.names, "units": plot.units,
                "rows": [[pair(value) for value in row] for row in plot.rows],
                "selected": selected, "annotations": annotations}
    if op == "expression":
        data = call["plot"]
        plot = Plot(data["title"], data["names"], data["units"],
                    [[complex(*value) if value else complex(math.nan) for value in row]
                     for row in data["rows"]])
        return [pair(value) for value in evaluate(call["expression"], plot)]
    project = Project.load(json.dumps(call["project"]))
    if op == "netlist":
        measurements = []
        deck = netlist(project, measurements)
        mode = project.profiles[project.active].mode
        if mode == "OP" and call.get("annotate"):
            instrumented, operating_point = bias_deck(project)
            return {"deck": deck, "input": analysis_deck(instrumented), "measurements": measurements,
                    "operating_point": operating_point, "mode": mode}
        return {"deck": deck, "input": analysis_deck(deck), "measurements": measurements, "mode": mode}
    if op == "move":
        dx, dy = call["delta"]
        translate_selection(project, *call["selection"], dx, dy)
    elif op == "edit_part":
        part = project.parts[call["index"]]
        ref, value = call["ref"].strip(), call["value"].strip()
        if not ref or any(item is not part and item.ref.upper() == ref.upper()
                          for item in project.parts):
            raise ValueError("Component references must be nonempty and unique")
        if part.kind in "VI":
            source_value(value)
        elif part.kind in "RCL" and number(value) <= 0:
            raise ValueError("Component value must be positive")
        for marker in project.markers:
            if marker["kind"] == "I" and marker["ref"].upper() == part.ref.upper():
                marker["ref"] = ref
        part.ref, part.value = ref, value
    elif op == "profile":
        if call["edit"] == "remove":
            project.remove_active_profile()
        elif call["edit"] == "update":
            profile = Profile(**call["fields"])
            profile.directive()
            project.profiles[project.active] = profile
        else:
            project.add_profile(call["name"], call["mode"], call["edit"] == "duplicate")
    elif op == "place":
        entry = call["entry"]
        kind = entry["kind"]
        project.add(kind, call["point"])
        part = project.parts[-1]
        if "qucs" in entry:
            part.value = project.register_qucs_diode(LibraryDiode(**entry["qucs"]))
        elif "value" in entry:
            part.value = entry["value"]
            if kind == "X":
                part.port_names = project.subcircuits[part.value]["ports"].copy()
            elif kind in "QMJS":
                part.port_names = list(MODEL_PORTS[project.device_models[part.value]["type"]][1])
    elif op == "rotate":
        part = project.parts[call["index"]]
        before = connectivity(project)
        previous = part.pins()
        other = {pin for item in project.parts if item is not part for pin in item.pins()}
        part.rotation = (part.rotation + 1) % 4
        if part.kind not in "GN" and any(
                pin in other or pin in project.junctions or any(on_wire(pin, wire) for wire in project.wires)
                for pin in (*previous, *part.pins())):
            raise ValueError("Disconnect nearby wires and terminals before rotating.")
        if part.kind in "GN" and connectivity(project) != before:
            raise ValueError("Rotation would change connectivity.")
    elif op == "import":
        catalog, issues, count = [], [], 0
        with TemporaryDirectory() as directory:
            path = Path(directory) / "library.txt"
            for file in call["files"]:
                path.write_text(file["text"].lstrip("\ufeff"), encoding="utf-8")
                try:
                    if file["text"].lstrip("\ufeff \t\r\n").startswith("<Qucs Library"):
                        catalog.extend(map(asdict, import_diodes(path, number)))
                        continue
                    models, subcircuits, skipped = read_library(path, number)
                    for incoming, existing in ((models, project.device_models),
                                               (subcircuits, project.subcircuits)):
                        for name, entry in incoming.items():
                            if (name in existing and existing[name] != entry
                                    or incoming is models and
                                    (name in project.diode_models or name in project.qucs_models)):
                                skipped.append(f"Conflicting definition {name}")
                            elif name not in existing:
                                existing[name] = entry
                                count += 1
                    issues.extend(f"{file['name']}: {message}" for message in skipped)
                except ValueError as error:
                    issues.append(f"{file['name']}: {error}")
        return {**view(project), "catalog": catalog, "issues": issues, "count": count}
    return view(Project.load(project.dump()))


def pair(value):
    return [value.real, value.imag] if math.isfinite(value.real) and math.isfinite(value.imag) else None


def dispatch(payload):
    return json.dumps(action(json.loads(payload)), allow_nan=False)
