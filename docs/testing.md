# Testing Guide

## Quick Start

```bash
npm test                 # Unit tests (no auth required)
npm run test:coverage    # Unit tests with coverage
```

CI is fake/unit only (`src/tests/unit`, fully mocked, no external dependencies or auth).

## Test Structure

- `src/tests/unit/` - Unit tests (mocked, no external dependencies)

## Unit Tests

**Requirements:** None - fully self-contained

**Coverage:**
- Request validation and schema compliance
- Error handling and edge cases
- Date/time parsing and timezone conversion logic
- Mock-based handler functionality
- Tool registration and validation

**Run with:**
```bash
npm test
```

## Integration Tests

Removed. The former `src/tests/integration/` suites (direct, multi-account, LLM, docker, http) exercised unavailable write/multi-account/LLM tools and were deleted.

Live readonly verification is not yet shipped, pending separate approval and a dedicated calendar. No replacement live credentials, test calendar, or live suite is set up here.
