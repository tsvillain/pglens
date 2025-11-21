# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

