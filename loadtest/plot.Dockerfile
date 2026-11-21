# Image for loadtest/plot.py: Python + matplotlib, built once by loadtest/plot.sh.
FROM python:3.12-slim
RUN pip install --no-cache-dir matplotlib==3.9.2
WORKDIR /loadtest
ENTRYPOINT ["python", "/loadtest/plot.py"]
