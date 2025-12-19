# Notion Clone - Kolaboratívna aplikácia

Jednoduchá Notion-like aplikácia pre dvoch používateľov s real-time kolaboráciou.

## Funkcie

- Autentifikácia používateľov (prihlásenie/registrácia)
- Vytvorenie a správa stránok
- Rôzne typy blokov (text, nadpisy, zoznamy, citácie, kód)
- Real-time kolaborácia cez WebSocket
- Zdieľanie stránok medzi používateľmi
- Výber ikon pre stránky

## Predvolení používatelia

Po prvom spustení sa automaticky vytvoria dvaja testovaí používatelia:

| Email | Heslo |
|-------|-------|
| user1@example.com | password123 |
| user2@example.com | password123 |

## Inštalácia a spustenie

### 1. Nainštalujte závislosti

```bash
# Server
cd notion-app/server
npm install

# Client
cd notion-app/client
npm install
```

### 2. Spustite server

```bash
cd notion-app/server
npm run dev
```

Server beží na `http://localhost:5000`

### 3. Spustite klienta (v novom termináli)

```bash
cd notion-app/client
npm run dev
```

Klient beží na `http://localhost:3000`

## Použitie

1. Otvorte `http://localhost:3000` v prehliadači
2. Prihláste sa ako `user1@example.com` alebo `user2@example.com`
3. Vytvorte novú stránku kliknutím na "Add a page"
4. Píšte text a použite `/` pre výber typu bloku:
   - `/heading1` - Nadpis 1
   - `/heading2` - Nadpis 2
   - `/heading3` - Nadpis 3
   - `/bullet` - Odrážkový zoznam
   - `/numbered` - Číslovaný zoznam
   - `/quote` - Citácia
   - `/code` - Kód

5. Pre testovanie kolaborácie otvorte druhý prehliadač (alebo inkognito okno) a prihláste sa ako druhý používateľ

## Technológie

### Backend
- Node.js + Express
- Socket.io (real-time komunikácia)
- JWT autentifikácia
- JSON súbory ako databáza

### Frontend
- React 18
- React Router
- Socket.io-client
- Vite

## Štruktúra projektu

```
notion-app/
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Block.jsx
│   │   │   ├── PageView.jsx
│   │   │   └── Sidebar.jsx
│   │   ├── context/
│   │   │   └── AuthContext.jsx
│   │   ├── hooks/
│   │   │   └── useSocket.js
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   └── Workspace.jsx
│   │   ├── styles/
│   │   │   └── index.css
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
│
└── server/
    ├── config/
    │   └── database.js
    ├── middleware/
    │   └── auth.js
    ├── routes/
    │   ├── auth.js
    │   └── pages.js
    ├── data/          (vytvorí sa automaticky)
    │   ├── users.json
    │   └── pages.json
    ├── .env
    ├── index.js
    └── package.json
```

## Real-time kolaborácia

Aplikácia používa Socket.io pre synchronizáciu zmien medzi používateľmi:
- Keď jeden používateľ upraví stránku, zmeny sa okamžite zobrazia druhému
- Nové stránky sa automaticky objavia v sidebari
- Vymazané stránky sa odstránia v reálnom čase
