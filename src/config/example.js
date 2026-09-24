// The JSON behind "Use an example" on /createMockServer.
//
// It lives here as well as in public/custom.js because a static asset cannot
// import from src/ — Cloudflare serves it directly, and there is no build step
// to share a constant through. The duplication is checked rather than trusted:
// `npm run check:docs` fails if the two ever say different things.
//
// The server needs it in order to recognise its own example when it comes back
// in as a paste. Someone clicking the button and then Create has not told us
// anything about what they wanted to mock, so the admin table leaves those out.
export const CUSTOM_EXAMPLE = `{
  "todos": [
    { "id": 1, "title": "Test the loading state", "done": false, "userId": 1 },
    { "id": 2, "title": "Test the error state",   "done": true,  "userId": 1 },
    { "id": 3, "title": "Test the retry logic",   "done": false, "userId": 2 }
  ],
  "users": [
    { "id": 1, "name": "Asha Menon",  "team": "Platform" },
    { "id": 2, "name": "Wei Chen",    "team": "Product" }
  ]
}`;

// The spec behind "Use an example" on /openapiMockServer, kept twice and checked
// the same way. Chosen to show what the import does with a real API rather than
// a toy one: a shared /api/v1 prefix to strip, a list wrapped in { data }, a
// foreign key to keep in range, and a write that is not mocked.
export const CUSTOM_SPEC_EXAMPLE = `{
  "openapi": "3.0.3",
  "info": { "title": "Orders API", "version": "1.0.0" },
  "servers": [{ "url": "https://api.example.com" }],
  "paths": {
    "/api/v1/customers": {
      "get": { "responses": { "200": { "description": "All customers",
        "content": { "application/json": { "schema": {
          "type": "array", "items": { "$ref": "#/components/schemas/Customer" } } } } } } }
    },
    "/api/v1/customers/{id}": {
      "get": { "responses": { "200": { "description": "One customer",
        "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Customer" } } } } } }
    },
    "/api/v1/orders": {
      "get": { "responses": { "200": { "description": "A page of orders",
        "content": { "application/json": { "schema": {
          "type": "object",
          "properties": {
            "data": { "type": "array", "items": { "$ref": "#/components/schemas/Order" } },
            "total": { "type": "integer" } } } } } } } },
      "post": { "responses": { "201": { "description": "Created" } } }
    }
  },
  "components": {
    "schemas": {
      "Customer": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "name": { "type": "string" },
          "email": { "type": "string", "format": "email" },
          "city": { "type": "string" }
        }
      },
      "Order": {
        "type": "object",
        "properties": {
          "id": { "type": "integer" },
          "customerId": { "type": "integer" },
          "status": { "type": "string", "enum": ["placed", "shipped", "delivered", "cancelled"] },
          "total": { "type": "number" },
          "createdAt": { "type": "string", "format": "date-time" }
        }
      }
    }
  }
}`;
