# ei-website-backend

Order management backend API with user authentication, product/process orders, payment gateway integration (Razorpay), and role-based access control.

## Prerequisites

- Node.js (v20+)
- Docker and Docker Compose
- PostgreSQL (via Docker)

## Setup Instructions

### 1. Configure Environment Variables

Copy `.env.example` to `.env` and update the values:

```bash
cp .env.example .env
```

Edit `.env` and set:
- `DEV` - Set to `true` (or use `NODE_ENV=development`) to skip OTP for `client1@example.com` and return a JWT on login (no Mailtrap needed). Other users still require OTP.
- `RAZORPAY_KEY_ID` - Your Razorpay API key ID
- `RAZORPAY_KEY_SECRET` - Your Razorpay API key secret
- `ACCESS_TOKEN_SECRET` - A secure random string for JWT access tokens
- `REFRESH_TOKEN_SECRET` - A secure random string for JWT refresh tokens
- `MAIL_TOKEN` - Mailtrap sending API token (for OTP emails; optional—if missing, OTP is still returned in the login response for dev)
- `SENDER_MAIL` - Sender email for Mailtrap (e.g. your verified domain)
- Database credentials (if different from defaults)

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Services with Docker Compose

Start PostgreSQL and the Node.js application:

```bash
docker-compose up
```

This will:
- Start PostgreSQL on port `5432` (or `POSTGRES_PORT` from `.env`)
- Start the Node.js app on port `3000` (or `PORT` from `.env`)
- Auto-sync the database schema

### 4. Seed the Database

In a new terminal, run the seed script to populate the database with mock data:

```bash
node seed.js
```

This creates:
- **Admin users** (super_admin, admin, bd_manager) for testing protected routes
- **Customer users** (client1, client2)
- **Products and categories**
- **Sample orders** (product and process types)
- **Payment records** (Razorpay and cheque)

### 5. Test Credentials

After seeding, you can log in with:

**Super Admin:**
- Email: `superadmin@example.com`
- Password: `SuperAdmin@123`

**Admin:**
- Email: `admin@example.com`
- Password: `Admin@123`

**BD Manager:**
- Email: `bdmanager@example.com`
- Password: `BDManager@123`

**Customer:**
- Email: `client1@example.com`
- Password: `Client1@123`

## API Documentation

See [API.md](./API.md) for complete API documentation including:
- All available endpoints
- Request/response formats
- Authentication requirements
- Role-based access control

## Project Structure

```
├── src/
│   ├── users/          # User management & authentication
│   ├── orders/         # Order CRUD & workflow tracking
│   ├── products/       # Product & category management
│   ├── payments/       # Razorpay integration
│   └── middleware/     # Auth, logging, error handling
├── seed.js             # Database seeding script
├── docker-compose.yml  # Docker services configuration
└── API.md              # API documentation
```

## Development

- **Start dev server**: `npm run dev` (uses nodemon)
- **Start production**: `npm start`
- **Seed database**: `node seed.js`

## Environment Variables

Key variables in `.env`:
- `DATABASE_URL` - PostgreSQL connection string
- `PORT` - Server port (default: 3000)
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` - Razorpay credentials
- `ACCESS_TOKEN_SECRET` / `REFRESH_TOKEN_SECRET` - JWT secrets

## Notes

- Database auto-syncs on startup (`db.sync({ alter: true })`)
- Access tokens expire in 15 minutes
- Refresh tokens expire in 5 minutes
- Protected routes require `Authorization: Bearer <token>` header

