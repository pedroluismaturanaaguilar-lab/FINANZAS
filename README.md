# GUARDIAN FAMILIAR COS — Control Laboral

Sistema de control de asistencia, nómina y liquidación, con historial
salarial (Colombia 2025-2026) y pago de horas extra en quincena vencida.

## ¿Qué es esto?

- **Backend:** Node.js + Express.
- **Base de datos:** un archivo JSON en disco (sin dependencias nativas,
  para que la instalación en Render no falle nunca por compilación).
- **Frontend:** HTML + CSS + JavaScript plano (sin frameworks), servido
  como archivos estáticos por el mismo servidor.
- **Login:** usuario y contraseña guardados en el servidor, así que
  puedes entrar desde el computador y desde el celular con la misma
  cuenta y ver siempre la misma información.

Usuario y contraseña por defecto: **ADMIN / ADMIN123** (cámbiala en
Parámetros → Seguridad apenas entres).

## Probar en tu computador (opcional)

Necesitas tener [Node.js](https://nodejs.org) 18 o superior instalado.

```
cd cos-server
npm install
npm start
```

Abre `http://localhost:3000` en el navegador.

## Subir a Render

### Opción A: con el archivo render.yaml (recomendado)

1. Sube esta carpeta a un repositorio de GitHub (o GitLab).
2. En Render: **New → Blueprint**, selecciona el repositorio. Render
   leerá `render.yaml` y creará el servicio automáticamente, incluyendo
   un disco persistente montado en `/data` para que los datos NO se
   borren cuando vuelvas a desplegar la app.
3. Espera a que termine el build y abre la URL que te da Render.

### Opción B: manual (Web Service)

1. Sube la carpeta a un repositorio.
2. En Render: **New → Web Service**, conecta el repositorio.
3. Configura:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Muy importante — agrega un **Persistent Disk** (pestaña "Disks"):
   - Mount path: `/data`
   - Y crea una variable de entorno `DATA_DIR` = `/data`
   - Si no haces esto, los datos (trabajadores, asistencias, nóminas)
     se BORRAN cada vez que Render vuelve a desplegar la aplicación,
     porque el disco normal de Render no es permanente.
5. Despliega y abre la URL pública.

## Estructura de archivos

```
cos-server/
  server.js          → servidor Express (login, sesiones, API)
  db.js               → base de datos en archivo JSON + datos iniciales
  package.json
  render.yaml          → configuración para Render
  public/
    index.html          → pantalla de login
    app.html             → aplicación (dashboard, trabajadores, etc.)
    css/styles.css
    js/app.js            → toda la lógica de la aplicación
  data/
    db.json              → (se crea solo) aquí vive toda la información
```

## Notas importantes

- **Horas extra en quincena vencida:** las horas extra trabajadas en un
  período NO se pagan de inmediato; se pagan junto con la nómina del
  período siguiente. El sueldo base, transporte y recargo
  dominical/festivo sí se pagan de inmediato. Ver el panel "Manual de
  uso" dentro de la aplicación para más detalle.
- **Historial salarial:** contiene los períodos de salario mínimo,
  auxilio de transporte, jornada y recargos de Colombia 2025-2026. Si
  el Gobierno cambia el salario mínimo en el futuro, entra a
  "Historial salarial" dentro de la app y cierra el período vigente
  (ponle fecha "Hasta") y crea uno nuevo con el valor actualizado.
- **Esto no es un software contable/legal certificado.** Los cálculos
  de nómina y liquidación son una herramienta de apoyo y estimación;
  para el pago oficial verifica los valores con un contador o abogado
  laboral.
