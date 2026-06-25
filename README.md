# 🌾 AgriLink ZM — Farm to Market Platform

**AgriLink ZM** connects Zambian smallholder farmers directly to verified buyers. 
Payments are processed instantly via **InPay** (MTN, Airtel, Zamtel, SpeedPay, ZedMobile).
Feature-phone farmers access the platform via **USSD (*384*5544#)** using Africa's Talking.

---

## Architecture

```
agrilink/
├── src/
│   ├── index.js              — Express server entry point
│   ├── db/
│   │   ├── index.js          — PostgreSQL pool
│   │   ├── migrate.js        — Run schema migrations
│   │   └── seed.js           — Seed crops + sample data
│   ├── middleware/
│   │   └── auth.js           — JWT authentication
│   └── routes/
│       ├── auth.js           — Register, login, profile
│       ├── listings.js       — Farmer produce listings
│       ├── deals.js          — Buyer deals + InPay payment
│       ├── market.js         — Prices, buy orders, alerts
│       └── ussd.js           — Africa's Talking USSD handler
├── public/
│   └── index.html            — Frontend (agrilink.html)
├── .env.example              — Environment variables template
├── railway.json              — Railway deployment config
└── package.json
```

---

## Quick Start (Termux / Railway)

### 1. Clone or create repo
```bash
mkdir agrilink-zm && cd agrilink-zm
# Copy all files into this structure
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment
```bash
cp .env.example .env
# Edit .env with your Railway PostgreSQL URL and keys
```

### 4. Run database migrations
```bash
npm run db:migrate
```

### 5. Seed initial data
```bash
npm run db:seed
```

### 6. Start server
```bash
npm start
# or for development:
npm run dev
```

---

## Deploy to Railway

1. Push to GitHub: `github.com/qwert828/agrilink-zm`
2. Connect repo in Railway dashboard
3. Add PostgreSQL plugin — Railway auto-sets `DATABASE_URL`
4. Add environment variables in Railway settings:
   - `JWT_SECRET` — random 64-char string
   - `INPAY_API_URL` — `https://inpay-production.up.railway.app`
   - `INPAY_API_KEY` — your InPay merchant API key
   - `INPAY_MERCHANT_ID` — your InPay merchant ID
   - `AT_API_KEY` — Africa's Talking API key
   - `AT_USERNAME` — Africa's Talking username
   - `APP_URL` — your Railway deployment URL
5. Railway auto-deploys on every push ✅

---

## USSD Setup (Africa's Talking)

1. Sign up at africastalking.com
2. Create a USSD service with shortcode `*384*5544#`
3. Set callback URL to: `https://your-app.up.railway.app/api/ussd`
4. Test in AT sandbox before going live

**USSD Flow for Farmers (feature phones):**
```
Dial *384*5544#
→ Enter PIN
→ 1. Post Produce
  → Select crop (Maize, Soybeans, etc.)
  → Enter quantity (50kg bags)
  → Enter price per bag
  → Confirm → Listed instantly
→ 2. Market Prices (live from FRA/Soweto)
→ 3. My Account (earnings, deals)
→ 4. Price Alerts (SMS when price moves)
```

---

## InPay Integration

AgriLink uses **your own InPay platform** as the payment rail:

- **Collection**: Buyer pays via InPay → `POST /api/deals` initiates
- **Webhook**: InPay confirms payment → `POST /api/deals/webhook`
- **Disbursement**: AgriLink pays farmer via InPay disburse API
- **Fee**: 1.78% of transaction (same as InPay Starter plan)
- **Networks**: MTN MoMo, Airtel Money, Zamtel Kwacha, SpeedPay/Zanaco, ZedMobile

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register farmer or buyer |
| POST | `/api/auth/login` | Login |
| GET | `/api/auth/me` | My profile |
| GET | `/api/listings` | Browse listings |
| POST | `/api/listings` | Post produce (farmer) |
| POST | `/api/deals` | Buy + pay via InPay (buyer) |
| POST | `/api/deals/webhook` | InPay payment callback |
| GET | `/api/market/prices` | Live crop prices |
| GET | `/api/market/buy-orders` | Buyer demand board |
| POST | `/api/market/alerts` | Set price alert |
| POST | `/api/ussd` | Africa's Talking USSD |

---

## Revenue Model

| Stream | Rate | Description |
|--------|------|-------------|
| Transaction fee | 1.78% | Via InPay on every deal |
| Buyer subscription | K199/month | Premium listings, bulk orders |
| Data licensing | Negotiated | Price/volume data to FRA, NGOs, banks |
| SMS alerts premium | K49/month | Unlimited price alerts |

---

## Roadmap

- [x] MVP frontend (agrilink.html)
- [x] Backend API (Node.js/Express/PostgreSQL)
- [x] InPay payment integration
- [x] USSD state machine (Africa's Talking)
- [x] Buy orders / demand board
- [x] Price alerts via SMS
- [x] Farmer ratings
- [ ] Mobile app (PWA/TWA via Google Play)
- [ ] SADC expansion (Zimbabwe, Malawi, Mozambique)
- [ ] Logistics layer (CopperChill integration)
- [ ] Credit scoring via transaction history (InPay data)
- [ ] FRA/FISP integration for government subsidies

---

**Built by Aaron Phiri / InPay Zambia Limited**  
Part of the Phiri Group technology portfolio.
