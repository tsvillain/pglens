# pglens

A simple PostgreSQL database viewer tool. Perfect to quickly view and explore your PostgreSQL database through a web interface.

## Features

- 🗂️ **Table Browser**: View all tables in your database in a clean, searchable sidebar
- 📊 **Data Viewer**: Browse table rows with a modern, easy-to-read interface
- 🪟 **Multiple Tabs**: Open multiple tables simultaneously in separate tabs
- 🔄 **Sorting**: Click column headers to sort data (client-side sorting on current view)
- 📄 **Pagination**: Navigate through large tables with Previous/Next buttons (100 rows per page)
- 🔍 **Table Search**: Quickly find tables by name using the search bar
- 👁️ **Column Visibility**: Show or hide columns to focus on what matters
- 📏 **Column Resizing**: Resize columns by dragging the column borders
- 🎨 **Theme Support**: Choose between light, dark, or system theme
- 🔄 **Refresh Data**: Reload table data with a single click
- ⚡ **Optimized Performance**: Uses cursor-based pagination for efficient large table navigation
- 🔒 **SSL Support**: Configurable SSL modes with automatic recommendations on connection errors
- 🚀 **Easy Setup**: Install globally and run with a single command

## Installation

```bash
npm install -g pglens
```

Or install locally in your project:

```bash
npm install pglens
```

## Usage

Run pglens with your PostgreSQL connection string and optional port:

```bash
pglens --url postgresql://user:password@localhost:5432/dbname --port 54321
```

### Arguments

- `--url` (required): PostgreSQL connection string
  - Format: `postgresql://user:password@host:port/database`
  - Example: `postgresql://postgres:mypassword@localhost:5432/mydb`
- `--port` (optional): Port to run the web server on (default: 54321)
- `--sslmode` (optional): SSL mode for database connection (default: `prefer`)
  - `disable`: Disable SSL encryption
  - `require`: Require SSL, but don't verify certificate
  - `prefer`: Prefer SSL, but allow non-SSL fallback (default)
  - `verify-ca`: Require SSL and verify certificate authority
  - `verify-full`: Require SSL and verify certificate and hostname

### SSL Mode Examples

```bash
# Use default SSL mode (prefer)
pglens --url postgresql://postgres:secret@localhost:5432/myapp

# Require SSL without certificate verification (for self-signed certs)
pglens --url postgresql://postgres:secret@localhost:5432/myapp --sslmode require

# Disable SSL (for local development)
pglens --url postgresql://postgres:secret@localhost:5432/myapp --sslmode disable

# Full certificate verification (for production)
pglens --url postgresql://postgres:secret@localhost:5432/myapp --sslmode verify-full
```

### Connection Troubleshooting

If you encounter connection errors, pglens will automatically analyze the error and suggest an appropriate SSL mode:

```
✗ Failed to connect to PostgreSQL database: self signed certificate

💡 SSL Mode Recommendation: Try using --sslmode require
   Current SSL mode: verify-full
   Suggested command: Add --sslmode require to your command
```

### Basic Example

```bash
pglens --url postgresql://postgres:secret@localhost:5432/myapp --port 54321
```

Then open your browser to `http://localhost:54321` to view your database.

## Running with PM2 (Server Deployment)

For production use on a server, you can run pglens as a persistent process using [PM2](https://pm2.keymetrics.io/), a process manager for Node.js applications.

### Install PM2

```bash
npm install -g pm2
```

### Start pglens with PM2

```bash
pm2 start pglens -- --url postgresql://user:password@localhost:5432/dbname --port 54321
```

Or with SSL mode:

```bash
pm2 start pglens -- --url postgresql://user:password@localhost:5432/dbname --port 54321 --sslmode require
```

Or use PM2's ecosystem file for better configuration:

**ecosystem.config.js:**

```javascript
module.exports = {
  apps: [
    {
      name: "pglens",
      script: "pglens",
      args: "--url postgresql://user:password@localhost:5432/dbname --port 54321 --sslmode require",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
```

Then start with:

```bash
pm2 start ecosystem.config.js
```

### Useful PM2 Commands

```bash
# View running processes
pm2 list

# View logs
pm2 logs pglens

# Stop pglens
pm2 stop pglens

# Restart pglens
pm2 restart pglens

# Delete pglens from PM2
pm2 delete pglens

# Save PM2 process list (for auto-restart on reboot)
pm2 save

# Setup PM2 to start on system boot
pm2 startup
```

### Important Security Reminder

⚠️ **Warning**: When running pglens on a server, ensure you:

- Use a reverse proxy (nginx, Apache) with authentication
- Restrict access via firewall rules
- Use HTTPS/TLS encryption
- Consider adding authentication middleware
- Never expose it directly to the internet without proper security measures

## How It Works

1. **Start the server**: Run the `pglens` command with your database URL
2. **View tables**: The left sidebar shows all tables in your database
3. **Search tables**: Use the search bar to quickly filter tables by name
4. **Select a table**: Click on any table to view its data in a new tab
5. **Multiple tabs**: Open multiple tables at once - each opens in its own tab
6. **Sort data**: Click on column headers to sort the current view
7. **Customize columns**: Use the "Columns" button to show/hide columns or resize them by dragging borders
8. **Navigate pages**: Use Previous/Next buttons to load more rows (100 rows per page)
9. **Refresh data**: Click the refresh button (↻) to reload the current table
10. **Change theme**: Click the theme button (🌓) to switch between light, dark, or system theme

## Development

To develop or modify pglens:

```bash
# Clone or navigate to the project directory
cd pglens

# Install dependencies
npm install

# Run locally
node bin/pglens --url your-connection-string --port 54321
```

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) for details on:

- How to set up your development environment
- Code style and guidelines
- Pull request process
- Issue reporting

We appreciate all contributions, whether it's bug fixes, new features, documentation improvements, or feedback.

## Security Note

This tool is designed for local development use only. It has no authentication and should **never** be exposed to the internet or untrusted networks. Always use it on localhost or within a trusted network environment.

## License

MIT
