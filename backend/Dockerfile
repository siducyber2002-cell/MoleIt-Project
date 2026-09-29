FROM python:3.12-slim

WORKDIR /app

# tblite (GFN2-xTB) ships a compiled Fortran extension that needs these shared
# libraries. python:3.12-slim does not include them, which is why the import
# failed with "tblite C extension unimportable, cannot use C-API".
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libgfortran5 \
    && rm -rf /var/lib/apt/lists/*

# Small molecules gain nothing from multi-threaded xTB/BLAS, and on shared-CPU
# hosts (e.g. Render) extra threads just fight over a fraction of a core and
# make each calculation several times slower.
ENV OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]