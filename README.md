# Discord Emoji Usage Audit

EN | [中文](README.zh.md)

A tool for auditing emoji usage in a Discord server.

It checks when each emoji was last used and how many times it has been used in total, then outputs a sorted report so you can quickly find emojis that have gone unused for a long time and may be worth deleting.

## Usage

### Option 1: Download a Release

Download the archive for your platform from [GitHub Releases](https://github.com/Anong0u0/discord_emoji_usage_audit/releases). After extracting it, you will see:

- the executable
- `config.yml`
- `.env`

Fill in `.env`:

```env
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
```

Then edit `config.yml` and set at least the target server's `guildId`.

Run it with:

```bash
./emoji-audit-linux-amd64
```

On Windows:

```powershell
.\emoji-audit-windows-amd64.exe
```

After it finishes, the report will be written to `./output`.

### Option 2: Run the Source with Bun

First, clone the repository:

```bash
git clone https://github.com/anong0u0/discord_emoji_usage_audit.git
cd discord_emoji_usage_audit
```

Then install dependencies:

```bash
bun install
```

Create local config files:

```bash
cp .env.example .env
cp config.example.yml config.yml
```

After filling in `.env` and `config.yml`, run:

```bash
bun start
```

You can also override settings with CLI arguments:

```bash
bun start --guild-id 123456789012345678 --max-emojis 100
```
