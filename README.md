# S3ImageRutes📸

Proyecto en .NET Web API para reconocimiento facial usando la cámara del sistema, detección con OpenCV y comparación/registro en AWS Rekognition. Las visitas se almacenan localmente en un archivo `visits.json`.
API para listar y recuperar imágenes en S3 filtrando por fecha, transacción o faceId, con soporte para objetos archivados en Glacier/Deep Archive y solicitud de restore.

---

## 🛠 Requisitos previos

- ✅ Asegurarse de que el puerto 3000 esté libre antes de iniciar la API. Este proyecto utiliza por defecto la URL: http://localhost:3000
- ✅ Cuenta de AWS con permisos para Rekognition (crear un IAM User con AwsRekognitionFullAccess)
- ✅ Haber creado una colección facial en Rekognition

  
  Puedes crearla desde la [Consola de Amazon Rekognition (Collections)](https://console.aws.amazon.com/rekognition/home#/collections) o por CLI con:
  
  ```bash
  aws rekognition create-collection --collection-id mi-coleccion-facial
  ```
- ✅  Crear un archivo .env con las credenciales de AWS con permisos de basico de S3 (ListObjects,GetObject,Restoreobject):

  ```bash
  AWS_ACCESS_KEY_ID=TU_ACCESS_KEY
  AWS_SECRET_ACCESS_KEY=TU_SECRET_KEY
  AWS_REGION=us-west-2
  ```
---

## 📦 Instalación

1. Clona este repositorio:
  ```bash
  git clone https://github.com/MaribelMOA/FaceRec-AWS.git
  ```
2. CInstala dependencias node.js:
  ```bash
npm i
  ```
3. Corre el servidor:

 ```bash
npm run dev
  ```
---

## 🔧 Parámetros comunes (opcionales en los GET)

| Parámetro         | Tipo    | Default | Descripción |
|-------------------|---------|---------|-------------|
| `status`          | string  | —       | Filtra por subcarpeta/estado de operación (p. ej. `OK`, `NO_FACE`, `CANCELED`, `PLAN_FAILURE`, `CAPTURE_FAILED`, `AWS_ERROR`, `EXCEEDS_LIMIT`). Mapea a carpetas `faces/<status_folder>/...` y también funciona como filtro lógico de estado. |
| `return`          | string  | `urls`  | Modo de salida: `urls` (URL prefirmadas), `bytes` o `base64`. |
| `limit`           | int     | 50      | Máx. resultados (1–200). |
| `continuationToken`| string | —       | Token de paginación para traer el siguiente bloque. |
| `autoRestore`     | bool    | false   | Si `true`, solicita restore automáticamente para objetos archivados. |
| `restoreDays`     | int     | 1       | Días que el objeto restaurado permanece accesible (antes de re-archivarse). |
| `restoreTier`     | string  | Bulk    | `Bulk` (más barato, ~48h) o `Standard` (más rápido, ~12h) para la rehidratación. |

---
## 📌 Consultas disponibles

1. ## GET /images-by-date
📌 Descripción:
Lista imágenes de un día específico (yyyyMMdd) en el bucket S3.
Permite filtrar por estado de la operación (status → carpetas como faces/visitas/, faces/errors/), elegir formato de retorno (urls, bytes, base64) y opcionalmente solicitar restauración automática de objetos en Deep Archive.

### 📥 Parámetros Requeridos:
- date (string, yyyyMMdd)

### 📤 Ejemplo de uso:

 ```bash
 curl -X 'GET' \
    'http://localhost:3000/images-by-date?date=20250922&status=OK' \
    -H 'accept: */*'
```
#### ✅ Ejemplo de respuesta exitosa:

 ```json
{
  "success": true,
  "count": 3,
  "archivedPendingRestore": 1,
  "nextContinuationToken": null,
  "images": [
    {
      "key": "faces/visitas/tx1_face_20250924_120000.jpg",
      "url": "https://s3-presigned...",
      "archived": false,
      "restoreRequested": false,
      "restoreOngoing": false,
      "restoreExpiryDate": null
    },
    {
      "key": "faces/visitas/tx2_face_20250917_130000.jpg",
      "url": null,
      "archived": true,
      "restoreRequested": false,
      "restoreOngoing": false,
      "restoreExpiryDate": null,
      "note": "Este objeto está en Deep Archive. Usa /images-restore o autoRestore=true."
    },
    {
       "key": "faces/visitas/transaction09a5279f_465e80aa-413c-46c3-ae3f-3bbbc48100f5_20250922_210502.jpg",
       "url": null,
       "archived": true,
       "restoreRequested": true,
       "restoreOngoing": true,
       "restoreExpiryDate": null,
       "note": "Restore en progreso; reintenta más tarde."
     }

  ]
}

```

#### ❌ Ejemplos de error:

 ```json
{
  "success": false,
  "message": "Debe proporcionar una fecha válida (formato: yyyyMMdd)."
}
```

 ```json
{
  "success": false,
  "message": "No se encontraron imágenes para 20250924 con status OK."
}
```

2. ## GET http://localhost:3000/images-by-transaction
📌 Descripción:
Busca imágenes asociadas a un **transactionId.**
Ideal para rastrear todas las imágenes que pertenecen a una operación específica.

📥 Parámetros Requeridos:
- tx: ID de transacción a buscar (string).
- date (string, yyyyMMdd)

📤 Ejemplo de uso:

 ```bash
 curl -X 'GET' \
    'http://localhost:3000/images-by-transaction?tx=transaction8c5f29e6&return=bytes' \
    -H 'accept: */*'
```
✅ Ejemplo de respuesta exitosa:

 ```json
{
  "success": true,
  "count": 1,
  "archivedPendingRestore": 0,
  "images": [
    {
      "key": "faces/visitas/transaction8c5f29e6_face_20250922_210502.jpg",
      "bytes": "001110101101010101......",
      "archived": false,
      "restoreRequested": false,
      "restoreOngoing": false,
      "restoreExpiryDate": null
    }
  ]
}

```

❌ Ejemplos de error:

 ```json
{
  "success": false,
  "message": "Debe proporcionar el transactionId."
}
```

 ```json
{
  "success": false,
  "message": "No se encontraron imágenes para ese transactionId."
}
```
3. ## GET /images-by-faceid-date
📌 Descripción:
Busca imágenes específicas asociadas a un faceId y una fecha.
Útil para revisar todos los registros de un rostro en un día concreto.

📥 Parámetros Requeridos:
- faceId / faceid: ID de rostro.(string).
- date (string, yyyyMMdd)

📤 Ejemplo de uso:

 ```bash
 curl -X 'GET' \
    'http://localhost:3000/images-by-faceid-date?faceId=465e80aa-413c-46c3-ae3f-3bbbc48100f5&date=20250922
' \
    -H 'accept: */*'
```
✅ Ejemplo de respuesta exitosa:

 ```json
{
  "success": true,
  "count": 2,
  "archivedPendingRestore": 0,
  "images": [
    {
           "key": "faces/visitas/transaction72827321_465e80aa-413c-46c3-ae3f-3bbbc48100f5_20250922_200828.jpg",
           "url": "https:....",
           "archived": false,
           "restoreRequested": false,
           "restoreOngoing": false,
           "restoreExpiryDate": null
       },
       {
           "key": "faces/visitas/transaction8b462978_32b32a4b-0599-4c3f-9eb5-e5371f94d534_20250922_201103.jpg",
           "url": "https://...",
           "archived": false,
           "restoreRequested": false,
           "restoreOngoing": false,
           "restoreExpiryDate": null
       }

  ]
}

```

❌ Ejemplos de error:

 ```json
{
  "success": false,
  "message": "Debe proporcionar el faceId."
}
```
4. ## GET /images-restore
📌 Descripción:
Permite solicitar manualmente la restauración (rehidratación) de una imagen archivada en Glacier/Deep Archive para poder descargarla o generar URL temporal.

⚠️ Necesitas permisos IAM para s3:RestoreObject.

📥 Parámetros Requeridos:
- faceId / faceid: ID de rostro.(string).
- date (string, yyyyMMdd)

📤 Ejemplo de uso:

 ```bash
 curl -X 'GET' \
    'http://localhost:3000/images-restore?key=faces/visitas/transaction09a5279f_465e80aa-413c-46c3-ae3f-3bbbc48100f5_20250922_210502.jpg' \
    -H 'accept: */*'
```
 ```bash
 POST /images-restore
Content-Type: application/json
{
  "key": "faces/visitas/transaction09a5279f_465e80aa-413c-46c3-ae3f-3bbbc48100f5_20250922_210502.jpg",
  "days": 2,
  "tier": "Bulk"
}
```

✅ Respuesta exitosa

 ```json
{
  "success": true,
  "message": "Restore solicitado.",
  "tier": "Bulk",
  "days": 2,
  "estimatedWaitHintHours": 48
}
```

Si ya había un restore en progreso:

 ```json
{
  "success": true,
  "message": "El objeto no está en Deep Archive.",
  "alreadyAvailable": true
}

```
Si ya había un restore en progreso:

 ```json
{
    "success": true,
    "message": "Restore en progreso.",
    "restoreOngoing": true,
    "estimatedWaitHintHours": 12
}

```

❌ Ejemplos de error:

🔴 Posibles errores

- 403 AccessDenied: el usuario IAM no tiene s3:RestoreObject.
- 400 Bad Request: falta key.
- 500 Internal Error: error inesperado al procesar la solicitud.
