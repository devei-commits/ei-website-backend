## API Documentation

POSTMAN collection: https://blue-meteor-763804.postman.co/workspace/express_tut~9c90693b-4141-418d-9b12-1a8d60bfd8bd/collection/16450904-e4edddec-c4bc-4762-8b2b-1123094f0871?action=share&creator=16450904&active-environment=16450904-57161246-ed0a-4965-b74c-90c30f8b5e84

Base URL: `http://<host>:<PORT>/api/v1` (default `http://localhost:3000/api/v1`)

- Public routes: `/api/v1/health`, `/api/v1/users/*` (including `/api/v1/users/token` and `/api/v1/users/logout`), `/api/v1/otp/*`
- Protected routes (require `Authorization: Bearer <access_token>`): `/api/v1/orders/*`, `/api/v1/products/*`, `/api/v1/payments/*`, `/api/v1/users/me`, `/api/v1/users/addresses`
- Admin-only routes (Bearer token + role `super_admin`|`admin`|`bd_manager`): `/api/v1/users/getusers`, `/api/v1/users/:id/role`, `/api/v1/users/:id/payment-terms`, `/api/v1/roles/*`

---

### GET `/api/v1/health`

**Purpose**: Health check for load balancers, containers, or monitoring. No authentication required.

**Responses**:

- `200`  
  `{ "status": "ok" }`

---

## Auth & Users

### POST `/api/v1/users`

**Purpose**: Register a new user.

**Body (JSON)**:

```json
{
  "name": "Client One",
  "email": "client1@example.com",
  "password": "Client1@123",
  "gstNumber": "27BBBBB1111B2Z6",
  "billingAddress": "Client1 Billing, Mumbai, MH, 400001",
  "shippingAddress": "Client1 Shipping, Mumbai, MH, 400002"
}
```

- `name` (string, required)
- `email` (string, required, unique)
- `password` (string, required, must meet complexity rules)
- `gstNumber` (string, optional)
- `billingAddress` (string, optional)
- `shippingAddress` (string, optional)
- `paymentTerms` (string, optional, e.g. `"100% advance"`, `"50% advance / 50% on delivery"`)

**Responses**:

- `201`  
  `{ "status": "Success", "detials": "User created!" }`
- `400`  
  `{ "errors": [ "<validation message>", ... ] }`
- `409`  
  `{ "error": "Email already in use" }`
- `500`  
  `{ "error": "<message>" }`

---

### POST `/api/v1/users/login`

**Purpose**: Log in and obtain JWT access token + refresh token cookie.

**Body (JSON)**:

```json
{
  "email": "client1@example.com",
  "password": "Client1@123"
}
```

- `email` (string)
- `password` (string)

**Responses**:

- `200`
  - Sets `refreshToken` HTTP-only cookie
  - Body: `{ "token": "<access_jwt>" }`
- `400`  
  `{ "errors": [ "<validation message>", ... ] }`
- `404`  
  `{ "error": "Invalid credentials!" }`

---

### GET `/api/v1/users/token`

**Purpose**: Refresh access token using refresh-token cookie.

**Request**:

- Cookie: `refreshToken=<token>`

**Responses**:

- `200`
  - Renews `refreshToken` cookie
  - `{ "token": "<new_access_jwt>" }`
- `401` / `403` if missing/invalid/expired refresh token.

---

### GET `/api/v1/users/logout`

**Purpose**: Log out and clear refresh token.

**Request**:

- Cookie: `refreshToken=<token>`

**Responses**:

- `200`  
  Clears `refreshToken` cookie and deletes DB record.

---

### GET `/api/v1/users/me`

**Purpose**: Get the current user's own profile (from access token). Used for payment terms (advance %), mobile, and addresses. For **staff** (users with a `staff_profiles` row), the response also includes `roleId`, `roleName`, `roleLevel`, and `department` for admin-dashboard RBAC.

**Auth**: Requires `Authorization: Bearer <access_token>`.

**Request**: No body.

**Responses**:

- `200`
  ```json
  {
    "userid": 4,
    "fname": "Client",
    "lname": "One",
    "display_name": "Client One",
    "email": "client1@example.com",
    "mobile": "+919876543211",
    "usertype": "customer",
    "status": null,
    "verify_status": null,
    "advance_payment": true,
    "advance_amount": "50.00",
    "created_at": "2025-01-15T10:00:00.000Z",
    "addresses": [
      {
        "address_id": 5,
        "address_type": "billing",
        "address_line1": "Client1 Billing, Mumbai, MH, 400001",
        "city_text": "Mumbai",
        "state_text": "MH",
        "country_text": "India",
        "pincode": "400001",
        "phone": null
      },
      {
        "address_id": 6,
        "address_type": "shipping",
        "address_line1": "Client1 Shipping, Mumbai, MH, 400002",
        "city_text": "Mumbai",
        "state_text": "MH",
        "country_text": "India",
        "pincode": "400002",
        "phone": null
      }
    ]
  }
  ```
- `404`  
  `{ "error": "User not found" }`
- `401` / `403`  
  Missing or invalid token.

---

### GET `/api/v1/users/getusers`

**Purpose**: List users. Admin-only. Optional query `?staffOnly=true` returns only users that have a staff profile (internal team), with `role_id`, `role_name`, and `department` included for each.

**Auth**: `Authorization: Bearer <access_token>` and role `super_admin`, `admin`, or `bd_manager`.

**Responses**:

- `200`  
  Array of users. With `staffOnly=true`, each item includes `id` (same as `userid`), `role_id`, `role_name`, `department`.

---

### PATCH `/api/v1/users/:id/role`

**Purpose**: Set or update a user's staff role and department (creates or updates `staff_profiles`). Admin-only.

**Auth**: `Authorization: Bearer <access_token>` and role `super_admin`, `admin`, or `bd_manager`.

**Body (JSON)**:

- `roleId` (integer, required) — role_id from roles table
- `department` (string, optional) — one of `sales`, `rnd`, `quality_assurance`, `logistics`, `marketing`, `finance`

**Responses**:

- `200`  
  `{ "id": <userid>, "role_id": <role_id>, "role_name": "<name>", "department": "<department>" }`
- `400`  
  `{ "error": "roleId is required" }` or `{ "error": "Invalid roleId" }`
- `404`  
  `{ "error": "User not found" }`

---

### POST `/api/v1/users/addresses`

**Purpose**: Create an address for the current user (e.g. from cart checkout). User is taken from the JWT.

**Auth**: Requires `Authorization: Bearer <access_token>`.

**Body (JSON)**:

```json
{
  "address_line1": "Client1 Billing, Mumbai, MH, 400001",
  "address_line2": "",
  "city_text": "Mumbai",
  "state_text": "MH",
  "country_text": "India",
  "pincode": "400001",
  "address_type": "billing",
  "first_name": "Client",
  "last_name": "One",
  "phone": "+919876543211"
}
```

- `address_line1` (string, required)
- `address_line2` (string, optional)
- `city_text`, `state_text`, `country_text`, `pincode` (string, optional; `country_text` defaults to `"India"`)
- `address_type` (string, optional; default `"billing"`) – e.g. `billing`, `shipping`
- `first_name`, `last_name`, `phone` (string, optional)

**Responses**:

- `201`  
  Created address object:
  ```json
  {
    "address_id": 7,
    "user_id": 4,
    "address_line1": "Client1 Billing, Mumbai, MH, 400001",
    "address_line2": "",
    "city_text": "Mumbai",
    "state_text": "MH",
    "country_text": "India",
    "pincode": "400001",
    "address_type": "billing",
    "first_name": "Client",
    "last_name": "One",
    "phone": "+919876543211"
  }
  ```
- `400`  
  `{ "error": "address_line1 and user context required" }`
- `500`  
  `{ "error": "<message>" }`

---

### GET `/api/v1/users/getusers`

**Purpose**: Admin-only list of users. Use `?staffOnly=true` for User Management: returns users whose `usertype` matches any role in the roles table, with `role_id`, `role_name`, `department` (dynamic).

**Auth**: `Authorization: Bearer <token>`; role must be `super_admin`, `admin`, or `bd_manager`.

**Query**:

- `staffOnly` (optional): if `true`, returns only staff users with shape below. Otherwise returns all users with addresses (legacy).

**Response (when staffOnly=true)**:

- `200` — Array of:
  - `userid`, `id`, `display_name`, `email`, `mobile`, `role_id`, `role_name`, `department`, `status`, `created_at`

**Response (when staffOnly omitted)**:

- `200` — Array of users with `addresses` (legacy).

---

### POST `/api/v1/users/create`

**Purpose**: Admin-only; create a staff user. Role is resolved from the roles table by `roleId` (dynamic). Requires `user-management` module.

**Auth**: `Authorization: Bearer <token>`; `requireModule('user-management')`.

**Body (JSON)**:

- `firstName` (string, optional), `lastName` (string, optional)
- `display_name` (string, optional) — if omitted, derived from firstName + lastName
- `email` (string, required)
- `mobile` (string, optional)
- `password` (string, required, min 6 characters)
- `roleId` (number, required) — id from roles table (any role)
- `department` (string, optional)
- `status` (string, optional) — default `"active"`

**Request example**:

```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "mobile": "+1234567890",
  "password": "SecurePass123",
  "roleId": 6,
  "department": "Research & Development",
  "status": "active"
}
```

**Response**: `201` — Created user (same shape as getusers item). `400` — Validation error or invalid roleId. `409` — Email already in use.

---

### GET `/api/v1/users/:id`

**Purpose**: Admin-only; get one user by id for User Management view/edit. Same shape as one element of getusers with staffOnly=true.

**Auth**: `Authorization: Bearer <token>`; role `super_admin`, `admin`, or `bd_manager`.

**Responses**: `200` — User object. `404` — User not found.

---

### PATCH `/api/v1/users/:id/role`

**Purpose**: Admin-only; update a user's role (usertype) and department. `roleId` is resolved from the roles table (dynamic).

**Auth**: `Authorization: Bearer <token>`; requires `user-management` module.

**Body (JSON)**:

- `roleId` (number): id from roles table.
- `department` (string, optional): e.g. `"Research & Development"`.

**Responses**: `200` — `{ "id", "role_id", "role_name", "department" }`. `404` — User not found.

---

### PATCH `/api/v1/users/:id`

**Purpose**: Admin-only; update user profile (name, email, mobile, status).

**Auth**: `Authorization: Bearer <token>`; role `super_admin`, `admin`, or `bd_manager`.

**Body (JSON)** (all optional): `display_name` or `name`, `email`, `mobile`, `status`.

**Responses**: `200` — Updated user (same shape as getusers item). `404` — User not found.

---

### DELETE `/api/v1/users/:id`

**Purpose**: Admin-only; delete a user and related data (orders, order items, payments, addresses, doctor profile, refresh token). Requires `user-management` module.

**Auth**: `Authorization: Bearer <token>`; module `user-management`.

**Request**: No body. `:id` = user id.

**Response**:
- `200` — `{ "message": "User deleted" }`
- `404` — `{ "error": "User not found" }`
- `500` — `{ "error": "<message>" }`

---

## Roles

All `/api/v1/roles/*` require `Authorization: Bearer <token>` and module `role-management`. Data is stored in `roles`, `permissions`, and `role_permissions` tables.

### GET `/api/v1/roles`

**Purpose**: List all roles from DB for dropdowns (User Management, Role Management). `userCount` = users with that `usertype`; `permissionsSet` = role has at least one permission. Role ids 1–5 are system roles (match user usertypes).

**Request**: None.

**Response** `200`:
```json
[
  { "role_id": 1, "role_code": "super_admin", "role_name": "Super Admin", "description": null, "level": "admin", "status": "active", "userCount": 1, "permissionsSet": true, "createdAt": "2025-01-15" },
  { "role_id": 2, "role_code": "admin", "role_name": "Admin", "description": null, "level": "admin", "status": "active", "userCount": 2, "permissionsSet": true, "createdAt": "2025-01-15" }
]
```
- `500` — `{ "error": "<message>" }`

---

### GET `/api/v1/roles/module-definitions`

**Purpose**: Permission UI tree (modules + globalSettings). Loaded from `module_definitions` table; filtered by current user’s role (only modules the role has permission for).

**Request**: None.

**Response** `200`:
```json
{
  "modules": [
    { "moduleId": "dashboard", "moduleName": "Dashboard", "icon": "chart", "description": "...", "subModules": [{ "subModuleId": "dashboard-overview", "subModuleName": "Overview", "actions": { "view": false, "create": false, ... }, "columns": [...] }] }
  ],
  "globalSettings": { "accessToAllModules": false, "allowLogin": true, "sessionTimeout": 30, ... }
}
```
- `500` — `{ "error": "<message>" }`

---

### GET `/api/v1/roles/:id`

**Purpose**: Get one role by id from DB (for Role Details / permission display). `permissions.granted` is built from the role’s permissions (e.g. `"dashboard.view"`, `"user-management.view"`).

**Request**: None. `:id` = role_id.

**Response** `200`:
```json
{
  "role_id": 1,
  "role_code": "super_admin",
  "role_name": "Super Admin",
  "description": null,
  "level": "admin",
  "status": "active",
  "created_at": "2025-01-15T10:00:00.000Z",
  "updated_at": "2025-01-15T10:00:00.000Z",
  "permissions": { "granted": ["dashboard.view", "user-management.view", "role-management.view", "order-management.view"], "globalSettings": { "accessToAllModules": false, "allowLogin": true, ... } }
}
```
- `404` — `{ "error": "Role not found" }`
- `500` — `{ "error": "<message>" }`

---

### POST `/api/v1/roles`

**Purpose**: Create a role in DB and optionally assign permissions. `permissions.granted` can be module IDs (e.g. `"dashboard"`) or keys (e.g. `"dashboard.view"`); each creates/links a permission with `resource` = first segment, `action` = `view`.

**Request**:
```json
{
  "role_code": "custom",
  "role_name": "Custom Role",
  "level": "staff",
  "description": null,
  "status": "active",
  "permissions": { "granted": ["dashboard", "user-management"], "globalSettings": {} }
}
```

**Response** `201`:
```json
{
  "role_id": 6,
  "role_code": "custom",
  "role_name": "Custom Role",
  "description": null,
  "level": "staff",
  "status": "active",
  "created_at": "2025-01-15T10:00:00.000Z",
  "updated_at": "2025-01-15T10:00:00.000Z",
  "permissions": { "granted": ["dashboard.view", "user-management.view"], "globalSettings": { ... } }
}
```
- `400` — `{ "error": "role_code, role_name, and level are required" }`
- `409` — `{ "error": "Role with this role_code already exists" }`
- `500` — `{ "error": "<message>" }`

---

### PUT `/api/v1/roles/:id`

**Purpose**: Update a role in DB. All fields optional. If `permissions.granted` is sent, role’s permissions are replaced with the given list (same semantics as POST for each entry). Each granted key can be a module ID (treated as `resource.view`) or a full key `resource.action` with `action` one of `view`, `create`, `edit`, `delete`.

**Request** (basic — module-level access):
```json
{
  "role_code": "custom",
  "role_name": "Custom Role Updated",
  "description": "Optional description",
  "level": "staff",
  "status": "active",
  "permissions": { "granted": ["dashboard", "role-management"], "globalSettings": {} }
}
```

**Request** (granular — per-resource view/create/edit/delete):
```json
{
  "role_name": "Editor Role",
  "permissions": {
    "granted": [
      "dashboard.view",
      "user-management.view",
      "user-management.edit",
      "user-management.create",
      "role-management.view",
      "order-management.view",
      "order-management.edit"
    ],
    "globalSettings": {}
  }
}
```

**Response** `200`: Same shape as GET `/roles/:id` with updated fields and `permissions.granted` reflecting current role_permissions.
- `404` — `{ "error": "Role not found" }`
- `500` — `{ "error": "<message>" }`

---

### DELETE `/api/v1/roles/:id`

**Purpose**: Delete a role from DB. Removes all `role_permissions` for that role, then deletes the role. System roles (id 1–5) cannot be deleted.

**Request**: None. `:id` = role_id.

**Response**:
- `200` — `{ "message": "Role deleted" }`
- `403` — `{ "error": "System roles cannot be deleted" }`
- `404` — `{ "error": "Role not found" }`
- `500` — `{ "error": "<message>" }`

---

## Roles (Admin dashboard RBAC)

> All `/api/v1/roles/*` require `Authorization: Bearer <access_token>` and role `super_admin` or `admin`. Used by the admin dashboard for role and permission management (staff only; clients have no staff_profile).

### GET `/api/v1/roles`

**Purpose**: List all roles. No full permissions in list; each item includes `permissionsSet` (boolean) indicating whether the role has any granted permission keys stored.

**Responses**: `200` — Array of role objects: `role_id`, `role_code`, `role_name`, `description`, `level`, `status`, `userCount`, `permissionsSet`, `createdAt`.

---

### GET `/api/v1/roles/module-definitions`

**Purpose**: Static list of modules/submodules/columns for the Permission Matrix UI (same structure as dashboard DEFAULT_MODULE_PERMISSIONS). Returns `{ modules, globalSettings }`.

**Responses**: `200` — `{ "modules": [ ... ], "globalSettings": { ... } }`

---

### GET `/api/v1/roles/:id`

**Purpose**: Get one role with permissions (minimal state: `granted` keys + `globalSettings`). Used by Edit Role, Role Details popup, and Permission Matrix.

**Responses**: `200` — Role object with `permissions: { granted: string[], globalSettings? }` (minimal state only; module tree is defined in the frontend). `404` if not found.

---

### POST `/api/v1/roles`

**Purpose**: Create a role. Backend stores only permission **state** (`granted` keys + optional `globalSettings`); the module tree is defined in the frontend so frontend changes do not require backend or API changes.

**Auth**: `Authorization: Bearer <access_token>` and role `super_admin`, `admin`, or `bd_manager`.


```json
{
  "role_code": "sales_lead",
  "role_name": "Sales Lead",
  "description": "Leads sales team and approvals",
  "level": "manager",
  "status": "active",
  "permissions": {
    "granted": [
      "dashboard.dashboard-overview.action.view",
      "dashboard.dashboard-overview.action.export",
      "dashboard.dashboard-overview.column.stats-cards.view",
      "order-management.orders-list.action.view"
    ],
    "globalSettings": {
      "accessToAllModules": false,
      "allowLogin": true,
      "allowMultipleSessions": false,
      "canChangePassword": true,
      "enableAuditLog": false,
      "canExportData": true,
      "canImportData": false,
      "canAccessReports": true,
      "canAccessSettings": false,
      "sessionTimeout": 30
    }
  }
}
```

**Responses**: `201` — Created role (body includes `role_id`, `role_code`, `role_name`, `description`, `level`, `status`, `permissions: { granted, globalSettings }`, `created_at`). `409` if `role_code` already exists. `400` if required fields missing.

---

### PUT `/api/v1/roles/:id`

**Purpose**: Update role. Same body shape as POST. `permissions` (if sent) replaces existing; only `granted` and `globalSettings` are stored.

**Auth**: `Authorization: Bearer <access_token>` and role `super_admin`, `admin`, or `bd_manager`.

**Body (JSON)**: Same as POST. All fields optional; `permissions` must use minimal state (`granted` array, optional `globalSettings`).

**Example** (update name and status only):

```json
{
  "role_name": "Sales Lead (Updated)",
  "status": "inactive"
}
```

**Example** (update permissions state):

```json
{
  "permissions": {
    "granted": ["dashboard.dashboard-overview.action.view", "order-management.orders-list.action.view"],
    "globalSettings": { "allowLogin": true, "sessionTimeout": 30 }
  }
}
```

**Responses**: `200` — Updated role. `404` if role not found.

---

### DELETE `/api/v1/roles/:id`

**Purpose**: Delete role only if no staff_profiles reference it.

**Responses**: `204` on success. `400` if role is in use.

---

## OTP

> `/api/v1/otp/*` routes are public (no Bearer token required).

### POST `/api/v1/otp/verifyotp`

**Purpose**: Verify the OTP sent to the user (e.g. after login or forgot-password). On success, sets `refreshToken` cookie and returns access token (same shape as login).

**Body (JSON)**:

```json
{
  "userid": 4,
  "otp": "123456"
}
```

- `userid` (integer, required) – user ID (e.g. from login / generate OTP response)
- `otp` (string, required) – 6-digit OTP received by email/SMS

**Responses**:

- `200`
  - Sets `refreshToken` HTTP-only cookie
  - Body: `{ "token": "<access_jwt>" }`
- `400`  
  `{ "error": "Invalid OTP or expired" }`
- `404`  
  `{ "error": "OTP not found" }` or `{ "error": "User not found" }`
- `500`  
  `{ "error": "<message>" }`

---

## Orders (populates Cart)

> All `/api/v1/orders/*` require `Authorization: Bearer <access_token>`.
>
> **Scoping by role**: The token's user `id` and `role` are used to scope data:
>
> - **Admin roles** (`super_admin`, `admin`, `bd_manager`): can list and access all orders.
> - **Other roles**: can only list and access their own orders (`userId` = token user id).

Order model (key fields):

- `id`
- `userId`
- `shippingAddress`, `shippingCity`, `shippingState`, `shippingZip`
- `total`
- `paymentStatus`: `pending | paid | failed | refunded`
- `status`: `pending | processing | shipped | delivered | cancelled | refunded`
- `orderType`: `product | process`
- `customRequirements` (process orders)
- `rdStatus`: `submitted | under_review | approved | rejected`
- `rdNotes`

---

### POST `/api/v1/orders`

**Purpose**: Create a new order. Uses address IDs (from GET `/users/me` addresses or POST `/users/addresses`) and line items with tax. Order total = subtotal + tax_total + shipping_total - discount_total.

**Body (JSON)**:

```json
{
  "billing_address_id": 5,
  "shipping_address_id": 6,
  "order_items": [
    {
      "product_id": 1,
      "quantity": 2,
      "unit_price": 1000.0,
      "tax_amount": 180.0,
      "discount_amount": 0
    }
  ],
  "shipping_total": 0,
  "discount_total": 100.0
}
```

- `billing_address_id` (integer, required)
- `shipping_address_id` (integer, required)
- `order_items` (array, required, min 1):
  - `product_id` (integer, required)
  - `quantity` (integer, required)
  - `unit_price` (number, required)
  - `tax_amount` (number, optional; default 0) – per-line tax for net-price consistency
  - `discount_amount` (number, optional; default 0)
- `shipping_total` (number, optional; default 0)
- `discount_total` (number, optional; default 0)

**Behavior**:

- Validates that all `product_id`s exist.
- Computes `subtotal`, `tax_total` from `order_items`, then `grand_total = subtotal + tax_total + shipping_total - discount_total`.
- Creates order with `order_status: "pending"`, `payment_status: "pending"`.
- Creates `order_items` records.

**Responses**:

- `201`  
  Order with items, e.g.:
  ```json
  {
    "order_id": 10,
    "user_id": 4,
    "billing_address_id": 5,
    "shipping_address_id": 6,
    "order_status": "pending",
    "payment_status": "pending",
    "subtotal": "2000.00",
    "discount_total": "100.00",
    "tax_total": "360.00",
    "shipping_total": "0.00",
    "grand_total": "2260.00",
    "created_at": "2025-02-18T12:00:00.000Z",
    "order_items": [
      {
        "order_item_id": 1,
        "order_id": 10,
        "product_id": 1,
        "quantity": 2,
        "unit_price": "1000.00",
        "tax_amount": "180.00",
        "line_total": "2000.00"
      }
    ]
  }
  ```
- `400`  
  `{ "error": "order_items is required and must be a non-empty array" }` or  
  `{ "error": "One or more products in your cart are no longer available.", "invalidProductIds": [2, 3] }`
- `500`  
  `{ "error": "<message>" }`

---

### GET `/api/v1/orders`

**Purpose**: List orders. Admins see all orders; other users see only their own (by token user id). Each order includes `payments` so the client can show cash-on-delivery (sum of `payments[].remainingAmount`).

**Request**: No body. Optional query: `?status=pending` (or `processing`, `shipped`, etc.) to filter.

**Responses**:

- `200`  
  Array of orders, each with `order_items` and `payments`:
  ```json
  [
    {
      "order_id": 10,
      "user_id": 4,
      "billing_address_id": 5,
      "shipping_address_id": 6,
      "order_status": "pending",
      "payment_status": "paid",
      "subtotal": "2000.00",
      "discount_total": "100.00",
      "tax_total": "360.00",
      "shipping_total": "0.00",
      "grand_total": "2260.00",
      "created_at": "2025-02-18T12:00:00.000Z",
      "order_items": [ ... ],
      "payments": [
        { "remainingAmount": "0.00" },
        { "remainingAmount": "1130.00" }
      ]
    }
  ]
  ```

  - `payments[].remainingAmount`: balance due (e.g. cash on delivery). Sum these to show “Cash on delivery” total.
- `500`  
  `{ "error": "<message>" }`

---

### GET `/api/v1/orders/:id`

**Purpose**: Get a single order with its items. User must own the order (or be admin).

**Responses**:

- `200`  
  `{ ...order, orderItems: [...] }`
- `403`  
  `{ "error": "Not allowed to view this order" }`
- `404`  
  `{ "error": "Order not found" }`

---

### PUT `/api/v1/orders/:id`

**Purpose**: Update order details (shipping, status, type, custom requirements). User must own the order (or be admin).

**Body (JSON)**: any combination of

```json
{
  "status": "shipped",
  "shippingAddress": "Updated Address, Mumbai, MH, 400003"
}
```

- `shippingAddress`, `shippingCity`, `shippingState`, `shippingZip`
- `status` (`pending|processing|shipped|delivered|cancelled|refunded`)
- `orderType` (`product|process`)
- `customRequirements` (string)

**Behavior**:

- Validates body (must include at least one updatable field).
- Updates the order.
- If `status` or `orderType` are present, appends `OrderStatusHistory`:
  - Fields: `orderId`, `status`, `step` (from `req.body.step` or `null`), `note` (custom or default).

**Responses**:

- `200`  
  Updated order JSON.
- `400`  
  `{ "errors": [ "<validation message>", ... ] }`
- `403`  
  `{ "error": "Not allowed to update this order" }`
- `404`  
  `{ "error": "Order not found" }`

---

### DELETE `/api/v1/orders/:id`

**Purpose**: Delete an order. User must own the order (or be admin).

**Responses**:

- `200`  
  `{ "message": "Order deleted" }`
- `403`  
  `{ "error": "Not allowed to delete this order" }`
- `404`  
  `{ "error": "Order not found" }`

---

### GET `/api/v1/orders/:id/status`

**Purpose**: Quick lookup of order status. User must own the order (or be admin).

**Responses**:

- `200`  
  `{ "id": <orderId>, "status": "<status>", "orderType": "<product|process>" }`
- `403`  
  `{ "error": "Not allowed to view this order" }`
- `404`  
  `{ "error": "Order not found" }`

---

### GET `/api/v1/orders/:id/history`

**Purpose**: Full lifecycle trace (status history). User must own the order (or be admin).

**Responses**:

- `200`  
  `[{ id, orderId, status, step, note, changedAt }, ...]` ordered by `changedAt ASC`.
- `403`  
  `{ "error": "Not allowed to view this order" }`
- `404`  
  `{ "error": "Order not found" }`

---

### PUT `/api/v1/orders/:id/rd-status`

**Purpose**: Update R&D status for process orders.

**Body (JSON)**:

```json
{
  "rdStatus": "approved",
  "rdNotes": "R&D confirms formulation is feasible and stable."
}
```

- `rdStatus` (required; one of `submitted | under_review | approved | rejected`)
- `rdNotes` (string, optional)

**Behavior**:

- Only allowed if `orderType === "process"`.
- Updates `rdStatus` and `rdNotes`.
- Adds `OrderStatusHistory` with:
  - `step: "RND_<RDSTATUS>"` (e.g. `RND_APPROVED`)
  - `note`: `rdNotes` or default.

**Responses**:

- `200`  
  Updated order JSON.
- `400`  
  `{ "error": "rdStatus must be one of: submitted, under_review, approved, rejected" }` or  
  `{ "error": "R&D status can only be updated for process orders" }`
- `404`  
  `{ "error": "Order not found" }`

---

## Payments

> All `/api/v1/payments/*` require `Authorization: Bearer <token>`.

Payment model (key fields):

- `id`
- `orderId`
- `userId`
- `gateway`: `razorpay | cheque | cod | wallet`
- `gatewayReference`: external reference (Razorpay order/payment ID, cheque no, etc.)
- `paymentId`: gateway payment ID
- `razorpayOrderId`: Razorpay order ID (for Razorpay gateway)
- `paidAmount`, `remainingAmount`
- `currency` (default `INR`)
- `status`: `pending | completed | failed | refunded`

---

### POST `/api/v1/payments/create`

**Purpose**: Create a Razorpay order and local `Payment` record.

**Body (JSON)**:

```json
{
  "orderId": 1,
  "amount": 1000.0,
  "currency": "INR",
  "receipt": "order_rcpt_1"
}
```

- `orderId` (integer, required)
- `amount` (number, required; rupees)
- `currency` (string, optional, default `INR`)
- `receipt` (string, optional)

**Behavior**:

- Validates body.
- Looks up local `Order`.
- Creates Razorpay order via SDK.
- Creates `Payment` with:
  - `orderId`, `userId`
  - `gateway: "razorpay"`
  - `gatewayReference` + `razorpayOrderId`
  - `paidAmount: 0`, `remainingAmount: amount`, `currency`, `status: "pending"`

**Responses**:

- `201`
  ```json
  {
    "razorpayOrder": { ... },
    "paymentId": <localPaymentId>,
    "key": "<RAZORPAY_KEY_ID>"
  }
  ```
- `400`  
  `{ "errors": [ "<validation message>", ... ] }`
- `404`  
  `{ "error": "Order not found" }`
- `500`  
  `{ "error": "<message>" }`

---

### POST `/api/v1/payments/verify`

**Purpose**: Verify Razorpay signature and finalize payment.

**Body (JSON)**:

```json
{
  "orderId": 1,
  "razorpayOrderId": "order_Mock123",
  "razorpayPaymentId": "pay_Mock456",
  "razorpaySignature": "generated_signature_here",
  "paymentMethod": "card",
  "paidAmount": 1000.0,
  "currency": "INR"
}
```

- `orderId` (integer, required)
- `razorpayOrderId` (string, required)
- `razorpayPaymentId` (string, required)
- `razorpaySignature` (string, required)
- `paymentMethod` (string, optional)
- `paidAmount` (number, required)
- `currency` (string, optional, default `INR`)

**Behavior**:

- Finds `Payment` by `razorpayOrderId` + `orderId`.
- Verifies signature using HMAC SHA256 and `RAZORPAY_KEY_SECRET`.
- On success:
  - Updates `Payment`:
    - `paymentId`, `gateway: "razorpay"`, `gatewayReference`, `paidAmount`, `remainingAmount`, `currency`, `status: "completed"`
  - If fully paid and `order.paymentStatus === "pending"`, sets `order.paymentStatus = "paid"`.

**Responses**:

- `200`  
  `{ "message": "Payment verified", "payment": { ... } }`
- `400`  
  `{ "errors": [ "<validation message>", ... ] }` or `{ "error": "Invalid payment signature" }`
- `404`  
  `{ "error": "Payment record not found" }`
- `500`  
  `{ "error": "<message>" }`

---

### POST `/api/v1/payments/approve-cheque`

**Purpose**: Admin-only. After the team has manually confirmed that a cheque payment was received, call this to mark the order as paid. Updates the order’s `payment_status` to `paid` and creates or updates a `cheque` payment record. The frontend payment icon for that order will show as paid on next load.

**Auth**: Requires `Authorization: Bearer <access_token>` and role in: `super_admin`, `admin`, `bd_manager`.

**Body (JSON)**:

```json
{
  "orderId": 12
}
```

- `orderId` (integer, required) – the order whose cheque payment is being approved.

**Responses**:

- `200`
  ```json
  {
    "message": "Cheque payment approved",
    "order": {
      "order_id": 12,
      "payment_status": "paid"
    },
    "payment": {
      "id": 5,
      "gateway": "cheque",
      "status": "completed"
    }
  }
  ```
- `400`  
  `{ "error": "orderId is required" }` or  
  `{ "error": "Order is already marked as paid" }`
- `403`  
  Caller’s role is not allowed.
- `404`  
  `{ "error": "Order not found" }`
- `500`  
  `{ "error": "<message>" }`

---

### PUT `/api/v1/users/:id/payment-terms`

**Purpose**: Admin-approved update of a user's payment terms (advance payment flag and amount).

**Auth**:

- Requires `Authorization: Bearer <token>`
- Token user must have role in: `super_admin`, `admin`, `bd_manager`.

**Body (JSON)**:

```json
{
  "advancePayment": true,
  "advanceAmount": 50
}
```

- `advancePayment` (boolean, optional) – whether advance payment is required
- `advanceAmount` (number, optional) – advance amount (e.g. percentage or fixed value). At least one of `advancePayment` or `advanceAmount` is required.

**Responses**:

- `200`  
  `{ "id": <userId>, "email": "<email>", "advancePayment": <bool>, "advanceAmount": <number|null> }`
- `400`  
  `{ "error": "At least one of advancePayment or advanceAmount is required" }`
- `403`  
  If caller's role is not allowed.
- `404`  
  `{ "error": "User not found" }`

---

## Products & Categories

> All `/api/v1/products/*` require `Authorization: Bearer <token>`.

Product model (key fields):

- `id`, `name`, `description`, `price`, `stock`, `categoryId`

Category model (key fields):

- `id`, `name`

---

### GET `/api/v1/products`

**Purpose**: List all products.

**Responses**:

- `200`  
  `[{ id, name, description, price, stock, categoryId, ... }, ...]`

---

### GET `/api/v1/products/:id`

**Purpose**: Get product by ID (with category).

**Responses**:

- `200`  
  `{ id, name, description, price, stock, category: { ... } }`
- `404`  
  `{ "error": "Product not found" }`

---

### POST `/api/v1/products`

**Purpose**: Create a new product. **Admin only** (`super_admin`, `admin`, `bd_manager`).

**Body (JSON)**:

```json
{
  "name": "Product A",
  "description": "Standard product with full advance payment.",
  "price": 1000.0,
  "stock": 100,
  "categoryId": 1
}
```

- `name` (string, required, unique)
- `description` (string, optional)
- `price` (number, required)
- `stock` (integer, required)
- `categoryId` (integer, required)

**Responses**:

- `200`  
  Newly created product object.
- `400`  
  `{ "errors": [ "<validation message>", ... ] }` or `{ "error": "Product already exists!" }`
- `500`  
  `{ "error": "<message>" }`

---

### PUT `/api/v1/products/:id`

**Purpose**: Update a product. **Admin only** (`super_admin`, `admin`, `bd_manager`). Partial updates supported; send only fields to change.

**Body (JSON)**:

```json
{
  "name": "Product A Updated",
  "description": "Updated description.",
  "price": 1200.0,
  "stock": 80,
  "categoryId": 2
}
```

- `name` (string, optional, 3–30 chars, unique)
- `description` (string, optional, 3–100 chars)
- `price` (number, optional)
- `stock` (integer, optional)
- `categoryId` (integer, optional)

At least one of the above fields is required.

**Responses**:

- `200`  
  Updated product object.
- `400`  
  `{ "errors": [ "<validation message>", ... ] }` or `{ "error": "Product name already in use" }`
- `404`  
  `{ "error": "Product not found" }`
- `500`  
  `{ "error": "<message>" }`

---

### DELETE `/api/v1/products/:id`

**Purpose**: Delete a product (soft delete via paranoid model). **Admin only** (`super_admin`, `admin`, `bd_manager`).

**Responses**:

- `200`  
  `{ "message": "Product deleted" }`
- `404`  
  `{ "error": "Product not found" }`

---

### GET `/api/v1/products/categories`

**Purpose**: List all categories.

**Responses**:

- `200`  
  `[{ id, name, ... }, ...]`

---

### POST `/api/v1/products/categories`

**Purpose**: Create a new category. **Admin only** (`super_admin`, `admin`, `bd_manager`).

**Body (JSON)**:

```json
{
  "name": "Chemicals"
}
```

- `name` (string, required, unique)

**Responses**:

- `200`  
  Newly created category object.
- `400`  
  `{ "errors": [ "<validation message>", ... ] }` or `{ "error": "Category already exists!" }`

---

### GET `/api/v1/products/categories/:id`

**Purpose**: Get a category by ID.

**Responses**:

- `200`  
  `{ id, name, ... }`
- `404`  
  `{ "error": "Category not found" }`

---

### PUT `/api/v1/products/categories/:id`

**Purpose**: Update a category. **Admin only** (`super_admin`, `admin`, `bd_manager`).

**Body (JSON)**:

```json
{
  "name": "Electronics"
}
```

- `name` (string, required, one of: `Electronics`, `Books`, `Clothing`, `Home & Kitchen`, `Beauty & Personal Care`, `Toys`, `Sports & Outdoors`, `Automotive`, `Health`, `Baby`, `Other`)

**Responses**:

- `200`  
  Updated category object.
- `400`  
  `{ "errors": [ "<validation message>", ... ] }` or `{ "error": "Category name already in use" }`
- `404`  
  `{ "error": "Category not found" }`
- `500`  
  `{ "error": "<message>" }`

---

### DELETE `/api/v1/products/categories/:id`

**Purpose**: Delete a category. **Admin only** (`super_admin`, `admin`, `bd_manager`).

**Responses**:

- `200`  
  `{ "message": "Category deleted" }`
- `404`  
  `{ "error": "Category not found" }`
