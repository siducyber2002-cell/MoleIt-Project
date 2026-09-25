"""Exact strongly-coupled spin-system simulation (AB, ABX, ABC, AMX, ...)
for up to a handful of mutually-coupled spin-1/2 nuclei, by directly
diagonalizing the spin Hamiltonian — the general case `nmr.py`'s
`ab_quartet_lines` handles analytically only for exactly 2 spins.

Why this is needed at all: first-order (n+1) splitting is a
*weak-coupling approximation*. It's only valid when every pairwise
shift separation is large relative to the coupling between that pair.
For 2 spins, the exact correction has a closed textbook formula (the
AB quartet). For 3+ spins there generally isn't one — the standard
treatment (Pople, Schneider & Bernstein; Corio's "Structure of
High-Resolution NMR Spectra") is to write the full spin Hamiltonian in
the 2^n-state product basis and diagonalize it, then read the observed
transition frequencies and intensities off the eigenvalues/eigenvectors.
That's exactly what this module does, generally, for any n (no
hardcoded formulas per spin count) — an ABX and an ABC system, or a
4-spin ABXY system, all go through the identical code path.

Physics, briefly (real, not hand-waved):

  H = sum_i nu_i * Iz_i  +  sum_{i<j} J_ij * (Iz_i Iz_j + 1/2(I+_i I-_j + I-_i I+_j))

in the product basis of |up/down> for each spin (nu_i = shift_i in Hz,
referenced from the same 0 ppm point for every spin — offsets on one
consistent scale, exactly like `ab_quartet_lines` already assumes).
This commutes with total Fz, so it block-diagonalizes by total M; we
don't bother building the blocks explicitly since the off-block-diagonal
entries are all exactly zero by construction, and a plain Jacobi
eigensolver on the full 2^n x 2^n matrix finds the same eigenvalues
either way (n stays small enough here that this costs nothing).

Transition frequencies are eigenvalue differences (in the same Hz
frame the input shifts are given in), and transition intensities are
|<a| F+ |b>|^2 where F+ = sum_i I+_i, evaluated in the Hamiltonian's
own eigenbasis (F+ = the sum of all single-spin raising operators;
matrix elements automatically vanish between eigenstates of different
total M, which is the standard single-quantum NMR selection rule and
comes out of this construction for free — no rule is hand-coded).

Setting J=0 between every pair collapses this exactly onto n
independent, uncoupled shifts (each transition frequency reduces to
the bare shift_i, verified in the test suite alongside this module).
Setting n=2 reproduces `ab_quartet_lines`'s closed-form AB quartet
exactly (also verified) — this is a strict generalization of that
function, not a different model living alongside it.
"""

from __future__ import annotations

from typing import Any, Dict, List


def _jacobi_eigen(matrix: List[List[float]], max_sweeps: int = 100, tol: float = 1e-12):
    """Classic cyclic Jacobi eigenvalue algorithm for a real symmetric
    matrix — pure Python, no numpy dependency (this project's
    requirements.txt doesn't carry one, and an 8x8 or 16x16 matrix is
    far too small to need a heavier solver anyway). Returns
    (eigenvalues, eigenvectors) where eigenvectors[i][j] is the i-th
    component of the j-th eigenvector (i.e. eigenvectors' *columns*
    are the eigenvectors, matching standard linear-algebra convention)."""
    n = len(matrix)
    a = [row[:] for row in matrix]
    v = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]

    for _ in range(max_sweeps):
        off = sum(abs(a[i][j]) for i in range(n) for j in range(n) if i != j)
        if off < tol:
            break
        for p in range(n):
            for q in range(p + 1, n):
                apq = a[p][q]
                if abs(apq) < 1e-14:
                    continue
                app, aqq = a[p][p], a[q][q]
                theta = (aqq - app) / (2 * apq)
                t = (1.0 if theta >= 0 else -1.0) / (abs(theta) + (theta * theta + 1) ** 0.5)
                c = 1.0 / ((t * t + 1) ** 0.5)
                s = t * c

                a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq
                a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq
                a[p][q] = 0.0
                a[q][p] = 0.0
                for i in range(n):
                    if i == p or i == q:
                        continue
                    aip, aiq = a[i][p], a[i][q]
                    a[i][p] = c * aip - s * aiq
                    a[p][i] = a[i][p]
                    a[i][q] = s * aip + c * aiq
                    a[q][i] = a[i][q]
                for i in range(n):
                    vip, viq = v[i][p], v[i][q]
                    v[i][p] = c * vip - s * viq
                    v[i][q] = s * vip + c * viq

    eigenvalues = [a[i][i] for i in range(n)]
    return eigenvalues, v


def simulate_spin_system(shifts_hz: List[float], j_matrix: List[List[float]], intensity_threshold: float = 0.0008) -> List[Dict[str, float]]:
    """Exact stick spectrum for `len(shifts_hz)` mutually-coupled
    spin-1/2 nuclei. `shifts_hz[i]` is spin i's shift, in Hz, on a scale
    shared by every spin (shift_ppm * spectrometer_MHz, same convention
    `ab_quartet_lines` uses). `j_matrix[i][j]` (symmetric, diagonal
    ignored) is the coupling between spins i and j, in Hz; 0 where two
    spins aren't coupled (e.g. not vicinal/geminal, or too many bonds
    apart to matter).

    Returns every transition with relative intensity above
    `intensity_threshold` (relative to the strongest line), as
    `[{freqHz, relativeIntensity}]`, sorted high to low frequency.
    Nearly-degenerate transitions (within 0.05 Hz — well below any real
    linewidth) are merged into one line with summed intensity, since
    two lines that close together are not separately resolvable and
    reporting them apart would just be numerical noise from the
    eigensolver, not a real spectral feature."""
    n = len(shifts_hz)
    dim = 1 << n

    def m_of(bit: int) -> float:
        return 0.5 if bit == 0 else -0.5

    bits_by_state = [[(state >> k) & 1 for k in range(n)] for state in range(dim)]

    H = [[0.0] * dim for _ in range(dim)]
    for state in range(dim):
        bits = bits_by_state[state]
        ms = [m_of(b) for b in bits]
        diag = sum(shifts_hz[k] * ms[k] for k in range(n))
        for i in range(n):
            for j in range(i + 1, n):
                diag += j_matrix[i][j] * ms[i] * ms[j]
        H[state][state] = diag
        for i in range(n):
            for j in range(i + 1, n):
                jij = j_matrix[i][j]
                if not jij:
                    continue
                if bits[i] != bits[j]:
                    other = state ^ (1 << i) ^ (1 << j)
                    H[state][other] += jij / 2.0

    eigenvalues, V = _jacobi_eigen(H)

    # Total raising operator F+ = sum_i I+_i in the product basis:
    # <state with bit k flipped 1->0 | I+_k | state> = 1.
    Fplus = [[0.0] * dim for _ in range(dim)]
    for state in range(dim):
        bits = bits_by_state[state]
        for k in range(n):
            if bits[k] == 1:
                new_state = state & ~(1 << k)
                Fplus[new_state][state] += 1.0

    # Change of basis into the Hamiltonian's eigenbasis: F+' = V^T F+ V.
    temp = [[sum(Fplus[i][k] * V[k][j] for k in range(dim)) for j in range(dim)] for i in range(dim)]
    Fplus_eig = [[sum(V[k][i] * temp[k][j] for k in range(dim)) for j in range(dim)] for i in range(dim)]

    raw_lines: List[Dict[str, float]] = []
    for a in range(dim):
        for b in range(a + 1, dim):
            amp = Fplus_eig[a][b] if abs(Fplus_eig[a][b]) >= abs(Fplus_eig[b][a]) else Fplus_eig[b][a]
            intensity = amp * amp
            if intensity < 1e-9:
                continue
            freq = abs(eigenvalues[a] - eigenvalues[b])
            if freq < 1e-6:
                continue  # a zero-quantum "transition" between degenerate states — not an observable line
            raw_lines.append({'freqHz': freq, 'intensity': intensity})

    raw_lines.sort(key=lambda l: -l['freqHz'])
    merged: List[Dict[str, float]] = []
    for line in raw_lines:
        if merged and abs(merged[-1]['freqHz'] - line['freqHz']) < 0.05:
            merged[-1]['intensity'] += line['intensity']
            merged[-1]['freqHz'] = (merged[-1]['freqHz'] + line['freqHz']) / 2.0
        else:
            merged.append(dict(line))

    if not merged:
        return []
    max_intensity = max(l['intensity'] for l in merged)
    out = []
    for line in merged:
        rel = line['intensity'] / max_intensity if max_intensity else 0.0
        if rel < intensity_threshold:
            continue
        out.append({'freqHz': round(line['freqHz'], 3), 'relativeIntensity': round(rel, 4)})
    return out


def simulate_spin_system_ppm(shifts_ppm: List[float], j_matrix_hz: List[List[float]], freq_mhz: float = 400.0, intensity_threshold: float = 0.0008) -> List[Dict[str, float]]:
    """Convenience wrapper: shifts in ppm in, line positions in ppm out
    (everything internally still runs in Hz, same as `ab_quartet_lines`)."""
    shifts_hz = [s * freq_mhz for s in shifts_ppm]
    lines = simulate_spin_system(shifts_hz, j_matrix_hz, intensity_threshold)
    for line in lines:
        line['ppm'] = round(line['freqHz'] / freq_mhz, 4)
        del line['freqHz']
    return lines