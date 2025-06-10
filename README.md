# 🔐 Private AI Signal Bot

This project is a lightweight, Dockerized AI chatbot that listens to your personal Signal messages via a prefix (`!ai`, `!img`, `!code`, `!weather`) and routes them to an LLM via a [Cloudflare AI Gateway Worker](https://developers.cloudflare.com/agents/).

## 🚀 Features

- 🔒 Private: Uses your personal Signal number securely.
- 💬 Prefix Parsing: Responds to commands like `!ai`, `!img`, `!code`, `!weather`.
- 🌩️ Fast & Cheap: Cloudflare Worker with AI Gateway.
- 🐳 Fully Dockerized using `docker-compose`.
- ⚙️ Minimal: Built in Go for performance and small footprint.

## 📦 Structure

```
my-ai-signal-bot/
├── bot/
│   ├── main.go
│   ├── go.mod
│   └── .env
├── worker/
│   └── agents sdk starter boilerplate
├── docker-compose.yml
└── README.md
```

## 🛠 Setup Instructions

### 1. Clone and configure

```bash
git clone https://github.com/youruser/my-ai-signal-bot.git
cd my-ai-signal-bot
cp bot/.env.example bot/.env  # then fill it out
```

### 2. Link your Signal device

```bash
docker-compose run signalbot signal-cli link -n my-signal-bot-name
```
This should generate a url that you need to generate a QR code for.
Scan the QR code using your Signal app.

### 3. Start the bot

```bash
docker-compose up
```

### 4. Deploy the Cloudflare Worker

```bash
cd worker
npm install
npx wrangler deploy
```

## 🧠 How It Works

- The Go bot uses `signal-cli` to receive messages.
- Supported commands:
  - `!ai <prompt>` → LLM completion
  - `!code <request>` → Code-oriented completion
  <!-- - `!img <description>` → Generate image (future extension) -->
  <!-- - `!weather <location>` → Custom logic/API call -->
- Replies are returned and sent via Signal.

## 💬 Example Usage

| Message | Bot Response |
|--------|--------------|
| `hello` | _Ignored_ |
| `!ai What is AI?` | LLM response |
| `!code Write a Go function` | Code block |
<!-- | `!weather London` | Weather data | -->

## 📜 License

GPLv3
