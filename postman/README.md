# Postman setup (Walit POS)

## API response format (app ke liye fixed)

Har endpoint isi envelope mein jawab deta hai:

**Success (2xx)**
```json
{
  "success": true,
  "data": { }
}
```
- Create/Get → `data` = object  
- List → `data` = `{ items, meta }`  
- Delete / Logout → `data` = `null`

**Error (4xx / 5xx)**
```json
{
  "success": false,
  "statusCode": 400,
  "error": "Bad Request",
  "message": "… or [\"validation…\"]",
  "path": "/v1/…",
  "timestamp": "…"
}
```

Frontend tip: pehle `if (!res.success)` handle karo, phir `res.data` use karo.

## Do sources — mix mat karo

| Source | Kya milta hai |
|--------|----------------|
| **A)** File: `Walit-POS-API.postman_collection.json` | Flat folders + ready bodies + auto-save tokens |
| **B)** Link: `http://localhost:3001/docs-json` | Nested folders (auth/login/…) from Swagger |

Swagger body examples code se aate hain (`@ApiProperty`).  
Hamari Postman file **alag static file** hai — Swagger automatically us file ko update nahi karta.

## File kaise import karein (bodies dikhengi)

1. Postman → **Import** → **File** (Link mat choose karo)
2. Select: `backend/postman/Walit-POS-API.postman_collection.json`
3. Collection name dikhega: **Walit POS API**
4. Collection variables check karo: `baseUrl`, `tenantSlug`, …

## Flow

1. **Register Tenant** ya **Login** (token + `storeId` auto-save from `data.*`)
2. Customers / Inventory requests — Bearer `{{accessToken}}` already set

## Agar nested auth/login dikhe

Woh **docs-json** import hai, hamari file nahi.  
Us collection ko delete/archive karke **File** se dubara import karo.

## Sidebar se 200 / 201 examples hatana

Swagger import ke baad Postman har request ke neeche **Examples** (200, 201, …) dikhata hai.

1. Postman se collection **Export** karo (Collection v2.1 JSON)
2. Backend folder se:

```bash
cd backend
npm run postman:strip-examples -- path/to/exported.json
```

Ya:

```bash
node postman/strip-examples.js path/to/exported.json
```

3. Output: `exported.clean.json` → Postman → **Import → File**
4. Purani collection delete / replace karo

Hamari ready file `Walit-POS-API.postman_collection.json` mein ye examples pehle se nahi hote.
