# Librerías de terceros

Archivos que antes se cargaban desde un CDN y ahora se sirven desde la propia plataforma, para que la
página no se quede en blanco si unpkg o jsdelivr tardan o fallan. Son los mismos archivos de antes:
cada uno coincide con la huella SHA-384 que `index.html` exigía.

| Archivo | Librería | Versión | Origen |
|---|---|---|---|
| `lucide.min.js` | Lucide (íconos) | 1.28.0 | https://unpkg.com/lucide@1.28.0/dist/umd/lucide.min.js |
| `xlsx.full.min.js` | SheetJS (leer Excel) | 0.18.5 | https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js |
| `chart.umd.min.js` | Chart.js | 4.5.1 | https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js |
| `chartjs-plugin-datalabels.min.js` | Etiquetas de datos para Chart.js | 2.2.0 | https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js |

Para actualizar una: bajar la versión nueva del mismo origen, reemplazar el archivo y probar las
secciones que la usan. Cada archivo nuevo que se agregue aquí tiene que sumarse también a
`STATIC_FILES` en `server.py`, que es la lista de lo único que el servidor entrega.
