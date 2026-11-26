"""Read a single ASCII ngspice plot and export vectors."""
import csv
from dataclasses import dataclass
import math
from pathlib import Path


@dataclass
class Plot:
    title: str
    names: list[str]
    units: list[str]
    rows: list[list[complex]]

    def marker_columns(self, measurements):
        indices = {name.lower(): index for index, name in enumerate(self.names)}
        selected = []
        for label, first, second in measurements:
            if second is None and first in indices and not label.startswith("I("):
                selected.append(indices[first])
                continue
            if label in self.names:
                selected.append(self.names.index(label))
                continue
            a, b = indices.get(first), indices.get(second)
            if ((a is None and first != "v(0)")
                    or (b is None and second not in (None, "v(0)"))):
                continue
            selected.append(len(self.names))
            self.names.append(label)
            self.units.append("current" if label.startswith("I(") else "voltage")
            for row in self.rows:
                row.append((row[a] if a is not None else 0j) - (row[b] if b is not None else 0j))
        return selected

    def export(self, path):
        with Path(path).open("w", newline="", encoding="utf-8") as file:
            writer = csv.writer(file)
            writer.writerow([field for name in self.names for field in (name + " real", name + " imaginary")])
            writer.writerows([field for value in row for field in (value.real, value.imag)] for row in self.rows)


def load_plot(path):
    with Path(path).open(encoding="ascii", errors="replace") as file:
        header = {}
        for line in file:
            if line.strip() == "Variables:":
                break
            if ":" in line:
                key, value = line.split(":", 1)
                header[key] = value.strip()
        count = int(header.get("No. Variables", 0))
        points = int(header.get("No. Points", 0))
        if count <= 0 or points <= 0 or count * points > 2_000_000:
            raise ValueError("Unsupported or empty waveform dimensions")
        names, units = [], []
        for index in range(count):
            fields = file.readline().split()
            if len(fields) < 3 or fields[0] != str(index):
                raise ValueError("Invalid waveform variable table")
            names.append(fields[1])
            units.append(fields[2])
        if file.readline().strip() != "Values:":
            raise ValueError("Expected ASCII ngspice values")

        def parse(token):
            fields = token.split(",")
            value = complex(*map(float, fields))
            if not math.isfinite(value.real) or not math.isfinite(value.imag):
                raise ValueError("Nonfinite simulation result")
            return value

        tokens = (token for line in file for token in line.split())
        rows = []
        try:
            for index in range(points):
                if next(tokens) != str(index):
                    raise ValueError("Invalid waveform point index")
                rows.append([parse(next(tokens)) for _ in range(count)])
        except (StopIteration, TypeError) as error:
            raise ValueError("Incomplete or invalid waveform data") from error
        if next(tokens, None) is not None:
            raise ValueError("Expected a single waveform plot")
    return Plot(header.get("Plotname", "Simulation"), names, units, rows)


def analysis_deck(deck):
    # Use the selected analysis directive directly in a control block so that
    # ngspice produces one ASCII plot, including for operating-point runs.
    body, directive, end = deck.rstrip().rsplit("\n", 2)
    if end != ".end" or not directive.startswith((".op", ".ac ", ".tran ", ".dc ")):
        raise ValueError("Expected a generated single-analysis netlist")
    return (f"{body}\n.control\nset filetype=ascii\n{directive[1:]}\n"
            "write result.raw all\nquit\n.endc\n.end\n")
