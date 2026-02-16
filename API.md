## API Documentation

<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

POSTMAN collection here: https://blue-meteor-763804.postman.co/workspace/express_tut~9c90693b-4141-418d-9b12-1a8d60bfd8bd/collection/16450904-e4edddec-c4bc-4762-8b2b-1123094f0871?action=share&creator=16450904&active-environment=16450904-57161246-ed0a-4965-b74c-90c30f8b5e84


<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>


Base URL: `http://<host>:<PORT>/api/v1` (default `http://localhost:3000/api/v1`)

- Public routes: `/api/v1/health`, `/api/v1/users/*` (including `/api/v1/users/token` and `/api/v1/users/logout`)
- Protected routes (require `Authorization: Bearer <access_token>`): `/api/v1/orders/*`, `/api/v1/products/*`, `/api/v1/payments/*`

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

### GET `/api/v1/users`

**Purpose**: Admin-only list of all users.

**Auth**:

- Requires `Authorization: Bearer <token>`
- Token user must have role in: `super_admin`, `admin`, `bd_manager`.

**Responses**:

- `200`
  ```json
  [
    {
      "id": 1,
      "name": "Admin User",
      "email": "admin@example.com",
      "gstNumber": "22AAAAA0000A1Z5",
      "billingAddress": "Admin Billing Address, City, State, 123456",
      "shippingAddress": "Admin Shipping Address, City, State, 123456",
      "paymentTerms": "100% advance",
      "role": "admin"
    }
  ]
  ```
- `403`  
  If caller's role is not allowed.
- `500`  
  `{ "error": "<message>" }`

---

### PUT `/api/v1/users/:id/payment-terms`

**Purpose**: Admin-approved update of a user's `paymentTerms`.

**Auth**:

- Requires `Authorization: Bearer <token>`
- Token user must have role in: `super_admin`, `admin`, `bd_manager`.

**Body (JSON)**:

```json
{
  "paymentTerms": "50% advance / 50% on delivery"
}
```

- `paymentTerms` (string, required; e.g. `"100% advance"`, `"Net 30 days"`)

**Responses**:

- `200`  
  `{ "id": <userId>, "email": "<email>", "paymentTerms": "<terms>" }`
- `400`  
  `{ "error": "paymentTerms is required and must be a string" }`
- `403`  
  If caller's role is not allowed.
- `404`  
  `{ "error": "User not found" }`

---

### GET `/api/v1/users/me`

**Purpose**: Get the current user's own profile (from access token).

**Auth**: Requires `Authorization: Bearer <access_token>`.

**Responses**:

- `200`  
  ```json
  {
    "id": 1,
    "name": "Client One",
    "email": "client1@example.com",
    "gstNumber": "27BBBBB1111B2Z6",
    "billingAddress": "Client1 Billing, Mumbai, MH, 400001",
    "shippingAddress": "Client1 Shipping, Mumbai, MH, 400002",
    "paymentTerms": "50% advance / 50% on delivery",
    "role": "customer"
  }
  ```
- `404`  
  `{ "error": "User not found" }`

---

## Orders (populates Cart)

> All `/api/v1/orders/*` require `Authorization: Bearer <access_token>`.
>
> **Scoping by role**: The token's user `id` and `role` are used to scope data:
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

**Purpose**: Create a new order (product or process).

**Body (JSON)**:

```json
{
  "shippingAddress": "Client1 Shipping, Mumbai, MH, 400002",
  "shippingCity": "Mumbai",
  "shippingState": "MH",
  "shippingZip": "400002",
  "status": "pending",
  "orderType": "product",
  "userId": 2,
  "orderItems": [
    {
      "productId": 1,
      "quantity": 1,
      "price": 1000.0
    }
  ]
}
```

Process order example:

```json
{
  "shippingAddress": "Factory Unit 5, Pune, MH, 411001",
  "shippingCity": "Pune",
  "shippingState": "MH",
  "shippingZip": "411001",
  "status": "pending",
  "orderType": "process",
  "customRequirements": "Custom machining per drawing DRW-2024-001; material: SS304; finish: brushed; tolerance ±0.05mm.",
  "userId": 2,
  "orderItems": [
    {
      "productId": 3,
      "quantity": 2,
      "price": 2500.0
    }
  ]
}
```

- `shippingAddress` (string, required)
- `shippingCity` (string, required)
- `shippingState` (string, required)
- `shippingZip` (string, required)
- `orderDate` (date, optional; default now)
- `status` (`pending|processing|shipped|delivered|cancelled|refunded`, optional; default `pending`)
- `orderType` (`"product"` or `"process"`, optional; default `"product"`)
- `customRequirements` (string; **required** if `orderType === "process"`)
- `userId` (integer, required)
- `orderItems` (array, required, min 1):
  - Each: `{ quantity: number, productId: number, price: number }`

**Behavior**:

- Computes `total` from `orderItems`.
- `paymentStatus` defaults to `pending`.
- Creates initial `OrderStatusHistory`:
  - `step: "PI"` for process orders.
  - `step: "CREATED"` for product orders.

**Responses**:

- `201`  
  Full order JSON including `id`, `total`, `orderItems`, etc.
- `400`  
  `{ "errors": [ "<validation message>", ... ] }` or `{ "error": "<message>" }`

---

### GET `/api/v1/orders`

**Purpose**: List orders. Admins see all orders; other users see only their own (by token user id).

**Responses**:

- `200`  
  `[{ ...order, orderItems: [...] }, ...]`

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
