#!/usr/bin/env python3
import os
import sys
import json
import requests
from dotenv import load_dotenv

# Load environment variables from .env
load_dotenv()

NOTION_TOKEN = os.getenv("NOTION_TOKEN")
NOTION_VERSION = "2025-09-03"
API_BASE = "https://api.notion.com/v1"

if not NOTION_TOKEN:
    print("Error: NOTION_TOKEN not set.", file=sys.stderr)
    sys.exit(1)

HEADERS = {
    "Authorization": f"Bearer {NOTION_TOKEN}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
}

def search_config_db():
    url = f"{API_BASE}/search"
    body = {
        "query": "CalDAV Sync Config",
        "filter": {"property": "object", "value": "data_source"},
        "page_size": 1,
    }
    resp = requests.post(url, headers=HEADERS, json=body)
    resp.raise_for_status()
    data = resp.json()
    results = data.get("results", [])
    for db in results:
        # Check title exact match just in case
        title_list = db.get("title", [])
        plain_title = "".join([t.get("plain_text", "") for t in title_list]).strip()
        if plain_title.lower() == "caldav sync config":
            return db.get("id"), db.get("url")
    return None, None

def create_config_db(parent_page_id):
    url = f"{API_BASE}/databases"
    
    # Description
    desc_text = (
        "⚙️ **CalDAV Sync Configuration**\n"
        "Use this database to map your Notion databases to specific Calendars.\n\n"
        "**How to use:**\n"
        "1. Add a new row for each database you want to sync.\n"
        "2. Paste the **Database ID** (from the URL or 'Copy Link') into the `Source Database ID` column.\n"
        "3. Enter the desired **Calendar Name** (e.g., 'Work', 'Personal') in the `Calendar Name` column.\n"
        "4. (Optional) Customize property names if your database uses different names."
    )

    body = {
        "parent": {"type": "page_id", "page_id": parent_page_id},
        "title": [
            {"type": "text", "text": {"content": "CalDAV Sync Config"}}
        ],
        "initial_data_source": {
            "properties": {
                "Source Database ID": {"title": {}},
                "Calendar Name": {"rich_text": {}},
                "Title Property": {"rich_text": {}},
                "Status Property": {"rich_text": {}},
                "Date Property": {"rich_text": {}},
                "Reminder Property": {"rich_text": {}},
                "Category Property": {"rich_text": {}},
                "Description Property": {"rich_text": {}},
            }
        }
    }
    
    # Note: Creating a DB via API requires setting the 'title' property type as 'title'.
    # But keys in properties dict are property names.
    # We want 'Source Database ID' to be the title property? 
    # Usually users prefer a human readable name as title. 
    # Let's make 'Config Name' the title, and Source ID a rich text?
    # Or strict: Source ID as title is fine.
    
    resp = requests.post(url, headers=HEADERS, json=body)
    if resp.status_code != 200:
        print(f"Failed to create database: {resp.text}", file=sys.stderr)
        resp.raise_for_status()
    
    data = resp.json()
    db_id = data["id"]
    
    # Update description (sometimes easier via patch if create didn't support it fully in old versions, but 2025 version should)
    # Actually create DB endpoint doesn't support 'description' field in all versions?
    # Let's PATCH it immediately to be safe.
    patch_url = f"{API_BASE}/databases/{db_id}"
    patch_body = {
        "description": [
            {"text": {"content": desc_text}}
        ]
    }
    requests.patch(patch_url, headers=HEADERS, json=patch_body)
    
    return db_id, data.get("url")

def main():
    print("Checking for 'CalDAV Sync Config' database...", file=sys.stderr)
    db_id, db_url = search_config_db()
    
    if db_id:
        print(f"✅ Found existing configuration database.", file=sys.stderr)
        print(f"   URL: {db_url}", file=sys.stderr)
        print(db_id)
        return

    print("⚠️  Configuration database not found.", file=sys.stderr)
    print("To act automatically, I need a Parent Page ID where I should create the config database.", file=sys.stderr)
    print("You can copy the ID from the URL of any page in your workspace.", file=sys.stderr)
    
    if not sys.stdin.isatty():
        print("Error: Cannot prompt for parent page ID in non-interactive mode.", file=sys.stderr)
        sys.exit(1)

    # Input comes from stdin (tty), so prompts go to stderr
    print("Enter Parent Page ID: ", end="", file=sys.stderr, flush=True)
    parent_id = sys.stdin.readline().strip()

    if not parent_id:
        print("Aborted.", file=sys.stderr)
        sys.exit(1)
        
    print(f"Creating database in page {parent_id}...", file=sys.stderr)
    try:
        new_id, new_url = create_config_db(parent_id)
        print(f"✅ Created 'CalDAV Sync Config' database!", file=sys.stderr)
        print(f"   URL: {new_url}", file=sys.stderr)
        print(new_id)
    except Exception as e:
        print(f"❌ Failed to create database: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
