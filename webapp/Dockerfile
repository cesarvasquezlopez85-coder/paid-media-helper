FROM python:3.11-slim

WORKDIR /app
COPY . .

# La base de datos vive en /data (fuera de /app) para poder montar ahí un
# volumen persistente sin que tape el código de la app en cada deploy.
ENV DATA_DIR=/data
ENV PMH_SECURE_COOKIES=1
RUN mkdir -p /data

EXPOSE 8642
CMD ["python3", "server.py"]
