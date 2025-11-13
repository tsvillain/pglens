# Contributing to pglens

Thank you for your interest in contributing to pglens! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How to Contribute](#how-to-contribute)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Coding Guidelines](#coding-guidelines)
- [Pull Request Process](#pull-request-process)
- [Reporting Issues](#reporting-issues)
- [Feature Requests](#feature-requests)
- [Commit Message Guidelines](#commit-message-guidelines)

## Code of Conduct

By participating in this project, you agree to:

- Be respectful and inclusive
- Welcome newcomers and help them learn
- Focus on constructive feedback
- Respect different viewpoints and experiences

## How to Contribute

There are many ways to contribute to pglens:

- 🐛 **Report bugs**: Help us identify and fix issues
- 💡 **Suggest features**: Share your ideas for improvements
- 📝 **Improve documentation**: Help make the docs clearer
- 🔧 **Submit code**: Fix bugs or add new features
- 🧪 **Test changes**: Help verify that changes work correctly

## Development Setup

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- PostgreSQL database (for testing)

### Getting Started

1. **Fork the repository** on GitHub

2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/pglens.git
   cd pglens
   ```

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Set up a test database**:
   - Create a PostgreSQL database for testing
   - Note the connection string for testing

5. **Test the installation**:
   ```bash
   node bin/pglens --url postgresql://user:password@localhost:5432/testdb --port 54321
   ```

6. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

## Project Structure

```
pglens/
├── bin/
│   └── pglens              # CLI entry point
├── client/                 # Frontend application
│   ├── app.js             # Main client-side JavaScript
│   ├── index.html         # HTML template
│   └── styles.css         # Stylesheet
├── src/
│   ├── db/
│   │   └── connection.js   # Database connection pool
│   ├── routes/
│   │   └── api.js         # API routes
│   └── server.js          # Express server setup
├── package.json
├── README.md
├── CHANGELOG.md
└── CONTRIBUTING.md
```

## Coding Guidelines

### General Principles

- **Keep it simple**: Prefer simple, readable solutions over clever ones
- **Follow existing patterns**: Match the style and structure of existing code
- **Document your code**: Add JSDoc comments for functions and complex logic
- **Remove debug code**: Don't commit `console.log` statements (except for production logs)
- **No commented code**: Remove commented-out code before submitting

### Code Style

- Use **2 spaces** for indentation
- Use **single quotes** for strings (unless escaping quotes)
- Use **camelCase** for variables and functions
- Use **PascalCase** for classes/constructors
- Add **semicolons** at the end of statements
- Maximum line length: **100 characters** (soft limit)

### Example

```javascript
/**
 * Example function with proper documentation.
 * @param {string} tableName - Name of the table
 * @param {number} limit - Maximum number of rows
 * @returns {Promise<Array>} Array of table rows
 */
async function fetchTableData(tableName, limit = 100) {
  if (!tableName) {
    throw new Error('Table name is required');
  }
  
  const pool = getPool();
  const query = `SELECT * FROM "${tableName}" LIMIT $1`;
  const result = await pool.query(query, [limit]);
  return result.rows;
}
```

### File Organization

- **One main export per file**: Keep modules focused
- **Group related functions**: Keep related code together
- **Separate concerns**: Database logic, API routes, and server setup should be separate

### Error Handling

- Always handle errors appropriately
- Use try-catch blocks for async operations
- Provide meaningful error messages
- Log errors with `console.error()` for debugging

```javascript
try {
  const result = await someAsyncOperation();
  return result;
} catch (error) {
  console.error('Operation failed:', error);
  throw new Error(`Failed to complete operation: ${error.message}`);
}
```

## Pull Request Process

### Before Submitting

1. **Test your changes**:
   - Test with a real PostgreSQL database
   - Verify the feature works as expected
   - Check for any console errors

2. **Update documentation**:
   - Update README.md if you add new features
   - Update CHANGELOG.md in the [Unreleased] section
   - Add/update JSDoc comments

3. **Check code quality**:
   - Remove debug code and console.log statements
   - Remove commented-out code
   - Ensure consistent formatting
   - Verify no linter errors

4. **Keep PRs focused**:
   - One feature or bug fix per PR
   - Keep changes small and reviewable
   - Split large changes into multiple PRs if needed

### PR Submission Steps

1. **Push your branch**:
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Create a Pull Request** on GitHub:
   - Use a clear, descriptive title
   - Fill out the PR template (if available)
   - Reference related issues (e.g., "Fixes #123")
   - Describe what changes you made and why

3. **PR Title Format**:
   ```
   type: Brief description
   ```
   
   Examples:
   - `feat: Add SSL mode configuration`
   - `fix: Resolve connection timeout issue`
   - `docs: Update README with SSL examples`
   - `refactor: Clean up connection error handling`

4. **PR Description Template**:
   ```markdown
   ## Description
   Brief description of what this PR does.

   ## Type of Change
   - [ ] Bug fix
   - [ ] New feature
   - [ ] Documentation update
   - [ ] Code refactoring

   ## Testing
   - [ ] Tested locally with PostgreSQL
   - [ ] Verified error handling
   - [ ] Checked for console errors

   ## Checklist
   - [ ] Code follows style guidelines
   - [ ] Documentation updated
   - [ ] CHANGELOG.md updated
   - [ ] No debug code committed
   ```

5. **Respond to feedback**:
   - Address review comments promptly
   - Make requested changes
   - Ask questions if something is unclear

### Review Process

- Maintainers will review your PR
- They may request changes or ask questions
- Once approved, your PR will be merged
- Thank you for your contribution! 🎉

## Reporting Issues

### Before Reporting

1. **Check existing issues**: Search to see if the issue is already reported
2. **Verify it's a bug**: Make sure it's not expected behavior
3. **Test latest version**: Ensure you're using the latest code

### Bug Report Template

When creating an issue, include:

```markdown
**Describe the bug**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Run command: `pglens --url ...`
2. Click on '...'
3. See error

**Expected behavior**
A clear description of what you expected to happen.

**Error Message**
```
Paste the full error message here
```

**Environment:**
- OS: [e.g., macOS 12.0, Ubuntu 20.04]
- Node.js version: [e.g., 16.14.0]
- pglens version: [e.g., 1.0.0]
- PostgreSQL version: [e.g., 14.2]

**Additional context**
Add any other context, screenshots, or information about the problem.
```

### Security Issues

**Do not** open public issues for security vulnerabilities. Instead, please email the maintainer directly or use GitHub's security advisory feature.

## Feature Requests

### Before Requesting

1. **Check existing issues**: See if the feature is already requested
2. **Consider the scope**: Ensure it fits the project's goals
3. **Think about implementation**: Consider how it might be implemented

### Feature Request Template

```markdown
**Is your feature request related to a problem?**
A clear description of what the problem is.

**Describe the solution you'd like**
A clear description of what you want to happen.

**Describe alternatives you've considered**
Any alternative solutions or features you've considered.

**Additional context**
Add any other context, mockups, or examples.
```

## Commit Message Guidelines

### Format

```
type(scope): subject

body (optional)

footer (optional)
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(ssl): Add SSL mode configuration flag

Add --sslmode flag with support for disable, require, prefer, verify-ca, and verify-full modes.

Fixes #42
```

```
fix(connection): Resolve timeout issues with SSL connections

Improve error handling for SSL connection timeouts and provide better error messages.
```

```
docs(readme): Update README with SSL mode examples

Add examples for each SSL mode and troubleshooting section.
```

### Best Practices

- Use imperative mood ("Add feature" not "Added feature")
- Keep subject line under 50 characters
- Capitalize the subject line
- Don't end subject with a period
- Reference issues in footer: `Fixes #123` or `Closes #456`

## Testing Guidelines

While we don't have automated tests yet, please:

1. **Test manually** with a real PostgreSQL database
2. **Test different scenarios**:
   - Different table sizes
   - Tables with and without primary keys
   - Various SSL modes
   - Error conditions

3. **Test edge cases**:
   - Empty tables
   - Very large tables
   - Special characters in table/column names
   - Connection failures

## Questions?

If you have questions about contributing:

- Open a discussion on GitHub
- Check existing issues and PRs
- Review the codebase to understand patterns

Thank you for contributing to pglens! 🙏

