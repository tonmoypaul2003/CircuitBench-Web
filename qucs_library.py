"""Import discrete diode models from the Qucs-S 0.0.10 library format."""
from dataclasses import dataclass
import re


# The historical library rows use this order, which differs from current
# schematic component serialization. Unmapped Qucs-specific fields are skipped.
PARAMETER_COLUMNS = {
    0: "IS", 1: "N", 2: "CJO", 3: "M", 4: "VJ", 5: "FC", 9: "RS",
    10: "TT", 12: "KF", 13: "AF", 15: "BV", 16: "IBV",
    17: "XTI", 18: "EG", 19: "TCV", 20: "TRS", 21: "TTT1", 22: "TTT2",
    23: "TM1", 24: "TM2", 25: "TNOM",
}
PARAMETERS = frozenset(PARAMETER_COLUMNS.values())


@dataclass(frozen=True)
class LibraryDiode:
    name: str
    description: str
    parameters: dict[str, str]


def import_diodes(path, parse_number):
    with path.open(encoding="utf-8-sig", errors="replace") as file:
        source = file.read(4_000_001)
    if len(source) > 4_000_000 or not re.match(r'<Qucs Library 0\.0\.10\s+"[^"]+">', source.lstrip()):
        raise ValueError("Expected a Qucs-S 0.0.10 library")
    entries = []
    for name, block in re.findall(r"<Component ([^<>\r\n]+)>(.*?)</Component>", source, re.S):
        rows = re.findall(r"^\s*<Diode ([^<>\r\n]+)>", block, re.M)
        if len(rows) != 1:
            continue
        model = re.search(r"<Model>\s*<Diode [^<>\r\n]+>\s*</Model>", block)
        if model is None:
            continue
        values = re.findall(r'"([^"]*)"\s+[01](?=\s|$)', rows[0])
        if len(values) not in (17, 27):
            continue
        if len(values) == 27:
            try:
                if parse_number(values[26]) != 1:
                    continue
            except ValueError:
                continue
        parameters = {}
        try:
            for index, key in PARAMETER_COLUMNS.items():
                if index >= len(values):
                    break
                token = values[index].strip()
                parse_number(token)
                parameters[key] = token
            for key in ("IS", "N"):
                if parse_number(parameters[key]) <= 0:
                    raise ValueError("Expected positive diode IS and N")
        except ValueError:
            continue
        description = re.search(r"<Description>(.*?)</Description>", block, re.S)
        entries.append(LibraryDiode(name.strip(),
                                    " ".join(description[1].split()) if description else "",
                                    parameters))
    if not entries:
        raise ValueError("No supported discrete diode models found in this Qucs-S library")
    return entries
