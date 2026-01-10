# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-01-11

### Added
- **Default Landing Page**: The app now defaults to an "All Connections" grid view on startup.
- **Simplified Sidebar**: Connection management (Edit/Delete) is now centralized on the Landing Page.
- **Smart View Switching**: Table list and search are hidden until a server is explicitly selected.

### Changed
- **Navigation Flow**: "Add Connection" and Logo clicks efficiently return you to the Landing Page.
- **Auto-Connect Disabled**: Adding a new connection returns to the grid instead of auto-opening the server.

### Fixed
- **View Persistence**: Reconnecting to an active server no longer overwrites open tabs with a loading screen.
- **Connection Updates**: Fixed issue where the connection grid would not update immediately after adding a server.

## [2.0.0] - 2026-01-01

### Added

- **Server-Side Sorting**: Table sorting is now performed on the database server, ensuring correct ordering across all data pages.
- **Connection Parameters Mode**: New tabbed interface in connection dialog allowing separate input for Host, Port, User, Password, and Database.
- **Global Loading Overlay**: Blocks user interaction during data fetching to prevent race conditions.
- **Dynamic Port Selection**: Server automatically finds an available port if 54321 is busy.
- **`pglens url` Command**: CLI command to display the currently running server URL.
- **Database Query Timeout**: Enforced 30-second timeout on all database operations.

### Changed

- Connection dialog now defaults to "Parameters" input mode for better usability.
- Switched to offset-based pagination when a custom sort order is active.
- Improved connection error handling and validation.

## [1.1.0] - 2025-11-21

### Added

- Cell content popup dialog for viewing full cell values (double-click any table cell)
- JSON formatting support for JSONB and JSON values in cell content popup with proper indentation
- Timezone selector for date/time values with multi-timezone display
- Select All button in column selector for quick column visibility management
- Copy-to-clipboard functionality in cell content popup

### Fixed

- JSONB columns now display as readable JSON instead of showing as object

### Changed

- Table cells now truncate with ellipsis for better table readability
- Improved cell content viewing experience with dedicated popup dialog

## [1.0.0] - Initial Release

### Added

- PostgreSQL database viewer with web interface
- Table browser with searchable sidebar
- Multi-tab support for viewing multiple tables simultaneously
- Data viewer with pagination (100 rows per page)
- Client-side column sorting
- Column visibility toggle
- Column resizing functionality
- Theme support (light, dark, system)
- Cursor-based pagination for efficient large table navigation
- Automatic primary key detection for optimized pagination
- Refresh data functionality
- PM2 deployment support documentation
- SSL mode configuration via `--sslmode` flag with support for: `disable`, `require`, `prefer`, `verify-ca`, `verify-full`
- Automatic SSL mode recommendations when connection fails
- Enhanced error messages with context-aware suggestions

### Security

- SQL injection prevention via table name sanitization
- Input validation for pagination parameters

[1.1.0]: https://github.com/tsvillain/pglens/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/tsvillain/pglens/releases/tag/v1.0.0

