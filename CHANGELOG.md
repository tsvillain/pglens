# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- SSL mode configuration via `--sslmode` flag with support for: `disable`, `require`, `prefer`, `verify-ca`, `verify-full`
- Automatic SSL mode recommendations when connection fails
- Enhanced error messages with context-aware suggestions

### Changed
- Improved production readiness by removing debug code and commented sections
- Updated connection error handling to provide actionable recommendations

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

### Security
- SQL injection prevention via table name sanitization
- Input validation for pagination parameters

[Unreleased]: https://github.com/tsvillain/pglens/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tsvillain/pglens/releases/tag/v1.0.0

