"""A pragmatic SMILES parser: turns a SMILES string into the same
{atoms, bonds} molecular-graph shape the rest of this app's `structure_2d`
JSON already uses, so an imported molecule is immediately a real, editable
structure. Ported from frontend/src/lib/smilesParser.js — mirrors
`derive_smiles`'s (app/formula.py) "approx." scope: it covers the organic
subset (uppercase atoms, common two-letter atoms, bracket atoms with
charge/H count, branches, ring closures, aromatic lowercase atoms) but
doesn't attempt full valence/aromaticity perception or stereochemistry.
2D layout is the same simple zigzag/curl heuristic the frontend used — the
canvas remains fully editable afterward to clean geometry up by hand.

Malformed input raises BadRequestError with the same human-readable
messages the frontend's SmilesError used to carry, so the existing
error-handling in routers/structure.py (and PropertiesPanel's
extractErrorMessage-based display) needs no special-casing for this.
"""

from __future__ import annotations

import math
import re
from typing import Any, Dict, List, Optional

from .exceptions import BadRequestError

BOND_LEN = 46
TWO_LETTER_ORGANIC = ('Cl', 'Br')
ORGANIC_SUBSET = {'B', 'C', 'N', 'O', 'P', 'S', 'F', 'Cl', 'Br', 'I'}
AROMATIC_LOWER = {'b', 'c', 'n', 'o', 'p', 's'}

_BRACKET_RE = re.compile(
    r'^(\d*)([A-Z][a-z]?|[a-z]{1,2})(@{0,2})(H\d?)?(\+{1,3}|-{1,3}|\+\d|-\d)?(:\d+)?$'
)


def _tokenize(smiles: str) -> List[Dict[str, Any]]:
    tokens: List[Dict[str, Any]] = []
    i = 0
    s = smiles.strip()

    while i < len(s):
        ch = s[i]

        if ch in '()':
            tokens.append({'type': ch})
            i += 1
            continue
        if ch in '-=#:/\\':
            tokens.append({'type': 'bond', 'symbol': ch})
            i += 1
            continue
        if ch == '%':
            digits = s[i + 1:i + 3]
            if not re.fullmatch(r'\d{2}', digits):
                raise BadRequestError(f'Malformed ring-closure at position {i}')
            tokens.append({'type': 'ring', 'number': digits})
            i += 3
            continue
        if ch.isdigit():
            tokens.append({'type': 'ring', 'number': ch})
            i += 1
            continue
        if ch == '[':
            close = s.find(']', i)
            if close == -1:
                raise BadRequestError('Unclosed bracket atom')
            inner = s[i + 1:close]
            m = _BRACKET_RE.match(inner)
            if not m:
                raise BadRequestError(f'Could not parse bracket atom [{inner}]')
            element, h_part, charge_part = m.group(2), m.group(4), m.group(5)
            charge = 0
            if charge_part:
                if re.fullmatch(r'[+-]\d', charge_part):
                    charge = int(charge_part)
                else:
                    charge = len(charge_part) if charge_part[0] == '+' else -len(charge_part)
            tokens.append({
                'type': 'atom',
                'element': (element[0].upper() + element[1:]) if len(element) <= 2 else element,
                'aromatic': bool(re.match(r'^[a-z]', element)),
                'charge': charge,
                'explicitH': (int(h_part[1:]) if len(h_part) > 1 else 1) if h_part else 0,
            })
            i = close + 1
            continue

        two = s[i:i + 2]
        if two in TWO_LETTER_ORGANIC:
            tokens.append({'type': 'atom', 'element': two, 'aromatic': False, 'charge': 0, 'explicitH': None})
            i += 2
            continue
        if ch.isupper() and ch.isalpha():
            if ch not in ORGANIC_SUBSET:
                raise BadRequestError(f'Unsupported atom symbol "{ch}"')
            tokens.append({'type': 'atom', 'element': ch, 'aromatic': False, 'charge': 0, 'explicitH': None})
            i += 1
            continue
        if ch in AROMATIC_LOWER:
            tokens.append({'type': 'atom', 'element': ch.upper(), 'aromatic': True, 'charge': 0, 'explicitH': None})
            i += 1
            continue
        if ch == '*':
            tokens.append({'type': 'atom', 'element': 'C', 'aromatic': False, 'charge': 0, 'explicitH': None})
            i += 1
            continue

        raise BadRequestError(f'Unexpected character "{ch}" at position {i}')

    return tokens


def parse_smiles(smiles: Optional[str]) -> Dict[str, Any]:
    """Parses a SMILES string into {atoms, bonds} in the app's graph
    shape. Raises BadRequestError with a human-readable message on
    invalid/unsupported input."""
    if not smiles or not smiles.strip():
        raise BadRequestError('Enter a SMILES string first.')

    tokens = _tokenize(smiles)
    atoms: List[Dict[str, Any]] = []
    bonds: List[Dict[str, Any]] = []
    atom_aromatic: Dict[str, bool] = {}  # internal only, mirrors JS's atom.__aromatic bookkeeping
    ring_opens: Dict[str, Dict[str, Any]] = {}  # digit -> {atomId, bondSymbol, aromatic}
    atom_counter = 0
    bond_counter = 0

    branch_stack: List[Dict[str, Any]] = []
    prev_atom_id: Optional[str] = None
    pending_bond: Optional[str] = None
    current_angle = 0.0
    current_x = 260.0
    current_y = 220.0
    flip = True
    sibling_index = 0
    aromatic_toggle = [True]  # mutable box so the nested fn can flip it

    def aromatic_order() -> int:
        order = 2 if aromatic_toggle[0] else 1
        aromatic_toggle[0] = not aromatic_toggle[0]
        return order

    def bond_order_for(symbol: Optional[str]) -> int:
        if symbol == '=':
            return 2
        if symbol == '#':
            return 3
        return 1

    def add_atom(element: str, charge: int) -> str:
        nonlocal atom_counter
        atom_id = f'a{atom_counter}'
        atom_counter += 1
        atoms.append({'id': atom_id, 'element': element, 'x': current_x, 'y': current_y, 'charge': charge or 0, 'lonePairs': 0})
        return atom_id

    def add_bond(from_id: str, to_id: str, order: int, aromatic: bool) -> str:
        nonlocal bond_counter
        bond_id = f'b{bond_counter}'
        bond_counter += 1
        bonds.append({
            'id': bond_id, 'from': from_id, 'to': to_id, 'order': order,
            'aromatic': bool(aromatic), 'style': 'aromatic' if aromatic else 'none',
        })
        return bond_id

    for tok in tokens:
        if tok['type'] == 'bond':
            pending_bond = tok['symbol']
            continue

        if tok['type'] == '(':
            branch_stack.append({
                'atomId': prev_atom_id, 'angle': current_angle, 'x': current_x, 'y': current_y,
                'flip': flip, 'siblingIndex': sibling_index,
            })
            continue

        if tok['type'] == ')':
            if not branch_stack:
                raise BadRequestError('Unbalanced parentheses.')
            frame = branch_stack.pop()
            prev_atom_id = frame['atomId']
            current_angle = frame['angle']
            current_x = frame['x']
            current_y = frame['y']
            flip = frame['flip']
            sibling_index = frame['siblingIndex'] + 1
            continue

        if tok['type'] == 'ring':
            if not prev_atom_id:
                raise BadRequestError('Ring-closure digit with no preceding atom.')
            key = tok['number']
            open_ = ring_opens.get(key)
            if open_:
                symbol = pending_bond or open_['bondSymbol']
                aromatic = (not symbol) and open_['aromatic']
                order = aromatic_order() if aromatic else bond_order_for(symbol)
                add_bond(open_['atomId'], prev_atom_id, order, aromatic)
                del ring_opens[key]
            else:
                ring_opens[key] = {
                    'atomId': prev_atom_id, 'bondSymbol': pending_bond,
                    'aromatic': atom_aromatic.get(prev_atom_id, False),
                }
            pending_bond = None
            continue

        if tok['type'] == 'atom':
            is_aromatic_bond_to_prev = (
                tok['aromatic'] and prev_atom_id and atom_aromatic.get(prev_atom_id, False) and not pending_bond
            )
            x, y = current_x, current_y
            angle_for_this_atom = current_angle

            if prev_atom_id:
                turn_base = 60 if tok['aromatic'] else 55
                if sibling_index == 0:
                    turn = turn_base if tok['aromatic'] else (turn_base if flip else -turn_base)
                else:
                    turn = (-1 if flip else 1) * (turn_base + 60 + sibling_index * 20)
                angle_for_this_atom = current_angle + turn
                rad = angle_for_this_atom * math.pi / 180
                x = current_x + BOND_LEN * math.cos(rad)
                y = current_y + BOND_LEN * math.sin(rad)

            atom_id = add_atom(tok['element'], tok['charge'])
            atom_aromatic[atom_id] = tok['aromatic']
            current_x, current_y, current_angle = x, y, angle_for_this_atom

            if prev_atom_id:
                symbol = pending_bond
                aromatic = (not symbol) and is_aromatic_bond_to_prev
                order = aromatic_order() if aromatic else bond_order_for(symbol)
                add_bond(prev_atom_id, atom_id, order, aromatic)

            pending_bond = None
            prev_atom_id = atom_id
            flip = flip if tok['aromatic'] else (not flip)
            sibling_index = 0

    if branch_stack:
        raise BadRequestError('Unbalanced parentheses.')
    if ring_opens:
        raise BadRequestError('A ring-closure digit was never matched.')
    if not atoms:
        raise BadRequestError('No atoms found in that SMILES.')

    return {'atoms': atoms, 'bonds': bonds}