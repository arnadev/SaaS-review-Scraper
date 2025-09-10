# Quick Start Guide

## Prerequisites

You need these installed:

1. **Node.js** (v16+)
   - Windows: Download from [nodejs.org](https://nodejs.org)
   - Mac: `brew install node`
   - Linux: `sudo apt install nodejs npm`

2. **Google Chrome** (Make sure it is installed on the system)

    (for browser automation - bot bypass for G2 and Capterra)
   - Download from [chrome.google.com](https://chrome.google.com)

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

  -run 'npm install' to install dependancies

2. **Run the scraper**
   ```bash
   node reviewScraper.js --company "Slack" --start-date "2024-01-01" --end-date "2024-03-31" --source "trustpilot"
   ```

## Usage Examples

**TrustPilot only:**
```bash
node reviewScraper.js --company "Slack" --start-date "2025-08-20" --end-date "2025-09-04" --source "trustpilot"
```

**G2 only (requires Chrome):**
```bash
node reviewScraper.js --company "Slack" --start-date "2025-08-20" --end-date "2025-09-04" --source "g2"
```

**Capterra only (requires Chrome):**
```bash
node reviewScraper.js --company "Slack" --start-date "2025-08-20" --end-date "2025-09-04" --source "capterra"
```

## Output

Reviews are saved to `reviews.json` by default.

## SAmple Output

node reviewScraper.js --company "Slack" --start-date "2025-08-20" --end-date "2025-09-04" --source "g2"

>Sample output of aboce command is inside the file sample_reviews.json

## Notes

- G2 and Capterra use browser automation (requires Chrome)
- G2 uses datadome, and Capterra uses cloudflare for anto scraping/botting
- TrustPilot uses HTTP requests only
- Browser window will open for G2/Capterra scraping (Please keep it in full screen, after which you can minimize it - this is for CSS purposes for scraping)
-very very rarely for new users a popup may show upon entering Capterra, it is random and very rare, if it appears please close it and rerun the script

NOTE: The script may face issues with popups and captchas when first run because of no browser data, please close any popups and rerun it, it should be running smoothly in consecutive runs (if issues occur in the first one)
## Author

Name: Arnav Challla
Email: arnav8703@gmail.com
(Mahindra University)