#!/bin/bash

# Test script for Google Calendar MCP Server HTTP mode using curl
# This demonstrates basic HTTP requests to test the MCP server

SERVER_URL="${1:-http://localhost:3000}"
SESSION_ID="curl-test-session-$(date +%s)"

echo "🚀 Testing Google Calendar MCP Server at: $SERVER_URL"
echo "🆔 Using session ID: $SESSION_ID"
echo "=================================================="

# Test 1: Health check
echo -e "\n🏥 Testing health endpoint..."
curl -s "$SERVER_URL/health" | jq '.' || echo "Health check failed"

# Test 2: Initialize MCP session
echo -e "\n🤝 Testing MCP initialize..."

# MCP Initialize request
INIT_REQUEST='{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "clientInfo": {
      "name": "curl-test-client",
      "version": "1.0.0"
    }
  }
}'

echo "Sending initialize request..."
INIT_RESPONSE=$(curl -s -X POST "$SERVER_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "$INIT_REQUEST")

# Try to parse as JSON, if that fails, check if it's SSE format
if echo "$INIT_RESPONSE" | jq '.' >/dev/null 2>&1; then
  # Direct JSON response - extract and parse the nested content
  echo "$INIT_RESPONSE" | jq -r '.result.content[0].text // empty' | jq '.' 2>/dev/null || echo "$INIT_RESPONSE" | jq '.'
elif echo "$INIT_RESPONSE" | grep -q "^data:"; then
  # SSE format - extract data and parse nested content
  echo "$INIT_RESPONSE" | grep "^data:" | sed 's/^data: //' | jq -r '.result.content[0].text // empty' | jq '.' 2>/dev/null
else
  echo "❌ Unknown response format"
  echo "$INIT_RESPONSE"
fi

# Check if initialization was successful
if echo "$INIT_RESPONSE" | grep -q "result\|initialize"; then
  echo "✅ Initialization successful"
else
  echo "❌ Initialization failed - stopping tests"
  exit 1
fi

# Test 3: List Tools request (after successful initialization)
echo -e "\n📋 Testing list tools..."
LIST_TOOLS_REQUEST='{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}'

TOOLS_RESPONSE=$(curl -s -X POST "$SERVER_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "$LIST_TOOLS_REQUEST")

# Parse response appropriately
if echo "$TOOLS_RESPONSE" | jq '.' >/dev/null 2>&1; then
  # Direct JSON - show the full tools list response (not nested content)
  echo "$TOOLS_RESPONSE" | jq '.result.tools[] | {name, description}'
elif echo "$TOOLS_RESPONSE" | grep -q "^data:"; then
  # SSE format
  echo "$TOOLS_RESPONSE" | grep "^data:" | sed 's/^data: //' | jq '.result.tools[] | {name, description}'
else
  echo "❌ List tools failed - unknown format"
  echo "$TOOLS_RESPONSE"
fi

# Test 4: Call list-calendars tool
echo -e "\n📅 Testing list-calendars tool..."

LIST_CALENDARS_REQUEST='{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "list-calendars",
    "arguments": {}
  }
}'

CALENDARS_RESPONSE=$(curl -s -X POST "$SERVER_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "$LIST_CALENDARS_REQUEST")

# Parse response appropriately
if echo "$CALENDARS_RESPONSE" | jq '.' >/dev/null 2>&1; then
  # Extract the nested JSON from content[0].text and parse it
  echo "$CALENDARS_RESPONSE" | jq -r '.result.content[0].text' | jq '.calendars[] | {id, summary, timeZone, accessRole}'
elif echo "$CALENDARS_RESPONSE" | grep -q "^data:"; then
  # SSE format - extract data, then nested content
  echo "$CALENDARS_RESPONSE" | grep "^data:" | sed 's/^data: //' | jq -r '.result.content[0].text' | jq '.calendars[] | {id, summary, timeZone, accessRole}'
else
  echo "❌ List calendars failed - unknown format"
  echo "$CALENDARS_RESPONSE"
fi

# Test 5: Call list-calendars tool (readonly check)
echo -e "\n📅 Testing list-calendars tool (readonly check)..."

LIST_CALENDARS_CHECK_REQUEST='{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "list-calendars",
    "arguments": {}
  }
}'

CALENDARS_CHECK_RESPONSE=$(curl -s -X POST "$SERVER_URL" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION_ID" \
  -d "$LIST_CALENDARS_CHECK_REQUEST")

# Parse response appropriately
if echo "$CALENDARS_CHECK_RESPONSE" | jq '.' >/dev/null 2>&1; then
  # Extract the nested JSON from content[0].text and parse it
  echo "$CALENDARS_CHECK_RESPONSE" | jq -r '.result.content[0].text' | jq '.calendars[] | {id, summary, timeZone, accessRole}'
elif echo "$CALENDARS_CHECK_RESPONSE" | grep -q "^data:"; then
  # SSE format - extract data, then nested content
  echo "$CALENDARS_CHECK_RESPONSE" | grep "^data:" | sed 's/^data: //' | jq -r '.result.content[0].text' | jq '.calendars[] | {id, summary, timeZone, accessRole}'
else
  echo "❌ List calendars check failed - unknown format"
  echo "$CALENDARS_CHECK_RESPONSE"
fi

echo -e "\n✅ HTTP testing completed!"
echo -e "\n💡 To test with different server URL: $0 http://your-server:port"
