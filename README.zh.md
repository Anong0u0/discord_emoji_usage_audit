# Discord Emoji Usage Audit

[EN](README.md) | 中文

一個用來稽核 Discord 伺服器 Emoji 使用狀況的工具。

查詢每個 emoji 最近一次出現時間與累積使用次數，並輸出排序後的報表，方便找出長期沒人使用、可考慮刪除的 Emoji。

## 使用方式

### 方式一：下載 Release 直接使用

到 [GitHub Releases](https://github.com/Anong0u0/discord_emoji_usage_audit/releases) 下載對應平台的壓縮檔，解壓後會看到：

- 執行檔
- `config.yml`
- `.env`

在 `.env` 中填入：

```env
DISCORD_BOT_TOKEN=YOUR_BOT_TOKEN
```

再編輯 `config.yml`，至少填入目標伺服器的 `guildId`。

執行方式：

```bash
./emoji-audit-linux-amd64
```

Windows：

```powershell
.\emoji-audit-windows-amd64.exe
```

執行完成後，報表會輸出到 `./output`。

### 方式二：用 Bun 跑原始碼

首先複製專案：

```bash
git clone https://github.com/anong0u0/discord_emoji_usage_audit.git
cd discord_emoji_usage_audit
```

再安裝依賴：

```bash
bun install
```

建立本地設定：

```bash
cp .env.example .env
cp config.example.yml config.yml
```

填好 `.env` 與 `config.yml` 後執行：

```bash
bun start
```

也可以帶參數覆寫設定：

```bash
bun start --guild-id 123456789012345678 --max-emojis 100
```
