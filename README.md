# pglens

A simple PostgreSQL database viewer tool. Perfect to quickly view and explore your PostgreSQL database through a web interface.

## Features

- 🔌 **Connection Manager**: Manage multiple database connections from a single UI
- 🚀 **Background Service**: Runs as a daemon process for persistent access
- 🗂️ **Table Browser**: View all tables in your database in a clean, searchable sidebar
- 📊 **Data Viewer**: Browse table rows with a modern, easy-to-read interface
- 📝 **Cell Content Viewer**: Double-click any cell to view full content in a popup
- 🎨 **JSON/JSONB Formatting**: Auto-formats JSON data with syntax highlighting
- 🕒 **Timezone Support**: View timestamps in local, UTC, or other timezones
- 📋 **Clipboard Support**: One-click copy for cell contents
- 🪟 **Multiple Tabs**: Open multiple tables simultaneously in separate tabs
- 🔄 **Server-Side Sorting**: Click column headers to sort data directly on the database server
- 📄 **Pagination**: Navigate through large tables with Previous/Next buttons
- 🔍 **Table Search**: Quickly find tables by name using the search bar
- 👁️ **Column Visibility**: Show or hide columns to focus on what matters
- 📏 **Column Resizing**: Resize columns by dragging the column borders
- 🎨 **Theme Support**: Choose between light, dark, or system theme
- ⚡ **Optimized Performance**: Uses cursor-based pagination for efficient large table navigation
- 🔒 **SSL Support**: Configurable SSL modes (Disable, Require, Prefer, Verify CA/Full)
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

### Start the Server

Start pglens as a background service:

```bash
pglens start
```

This will start the server on `http://localhost:54321` (or the next available port if 54321 is busy).
The URL will be printed to the console. You can also check the running URL at any time with:

```bash
pglens url
```

### Connect to a Database

1. Open `http://localhost:54321`
2. Click the **+** icon in the sidebar
3. Enter your connection details using one of the tabs:
   - **Parameters** (Default): Enter Host, Port, Database, User, and Password separately.
   - **Connection URL**: Paste a standard PostgreSQL connection string (e.g., `postgresql://user:pass@localhost:5432/db`).
4. Select the **SSL Mode** appropriate for your server.
5. Click **Connect**.

### Stop the Server

To stop the background service:

```bash
pglens stop
```

## How It Works

1. **Start**: Run `pglens start` to launch the background service
2. **Connect**: Add one or more database connections via the Web UI
3. **Explore**: 
   - Use the sidebar to browse tables across different connections
   - Double-click cells to view detailed content
   - Use the "Columns" menu to toggle visibility
   - Switch themes for comfortable viewing

## Development

To develop or modify pglens:

```bash
# Clone the repository
git clone https://github.com/tsvillain/pglens.git
cd pglens

# Install dependencies
npm install

# Run locally (starts server in foreground for logs)
node bin/pglens serve
```

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) for details on:

- How to set up your development environment
- Code style and guidelines
- Pull request process
- Issue reporting

## Security Note

This tool is designed for local development use. While it supports SSL for database connections, the web interface itself runs on HTTP (localhost) and has no user authentication. **Do not expose the pglens port (54321) directly to the internet.**

## License

MIT
