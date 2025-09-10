#!/usr/bin/env node
/**
 * Advanced SaaS Product Review Scraper
 * Scrapes reviews from G2, Capterra, and TrustPilot for specified companies and date ranges.
 * 
 * @author Arnav Challa
 * @version 1.0.0
 * 
 * Usage: node reviewScraper.js --company "Slack" --start-date "2024-01-01" --end-date "2024-03-31" --source "g2"
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs').promises;
const path = require('path');
const { program } = require('commander');
const moment = require('moment');

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const { chromium } = require('playwright');
const { html } = require('cheerio/lib/static');

// Base scraper class with common functionality
class ReviewScraper {
    constructor(delay = 2000, useHeadless = false) {
        this.delay = delay;
        this.useHeadless = useHeadless;
        this.axiosConfig = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            },
            timeout: 15000,
            maxRedirects: 5
        };
    }

    /**
     * Parse various date formats into Date object
     */
    parseDate(dateStr) {
        if (!dateStr || dateStr === 'Unknown' || dateStr === 'No date') return null;
        
        // Clean the date string
        dateStr = dateStr.trim().replace(/\s+/g, ' ');
        
        const formats = [
            'YYYY-MM-DD',
            'MMMM DD, YYYY',
            'MMM DD, YYYY', 
            'DD/MM/YYYY',
            'MM/DD/YYYY',
            'YYYY/MM/DD',
            'DD MMM YYYY',
            'MMM DD YYYY'
        ];

        for (const format of formats) {
            const parsed = moment(dateStr, format, true);
            if (parsed.isValid()) {
                return parsed.toDate();
            }
        }

        // Try natural parsing as fallback
        const naturalParsed = moment(dateStr);
        if (naturalParsed.isValid()) {
            return naturalParsed.toDate();
        }

        return null;
    }

    /**
     * Check if review date falls within specified range
     */
    isDateInRange(reviewDate, startDate, endDate) {
        if (!reviewDate) return false;
        return reviewDate >= startDate && reviewDate <= endDate;
    }

    /**
     * Rate limiting delay
     */
    async sleep(ms = null) {
        const delay = ms || this.delay + Math.random() * 1000; // Add randomness
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Safe HTTP request with retry logic
     */
    async safeRequest(url, maxRetries = 3) {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                await this.sleep();
                console.log(`Fetching: ${url.substring(0, 80)}${url.length > 80 ? '...' : ''}`);
                
                const response = await axios.get(url, this.axiosConfig);
                
                if (response.status === 200) {
                    console.log(`Request successful (${response.status}), content length: ${response.data.length} chars`);
                    return response;
                }
            } catch (error) {
                const statusCode = error.response?.status;
                const errorMessage = error.message;
                
                console.log(`❌ Request failed - Status: ${statusCode}, Error: ${errorMessage}`);
                
                if (statusCode === 429) {
                    const waitTime = Math.pow(2, attempt) * 2000; // exponential backoff
                    console.log(`⏳ Rate limited. Waiting ${waitTime/1000}s before retry...`);
                    await this.sleep(waitTime);
                } else if (statusCode === 403) {
                    console.log(`🚫 Access forbidden. Trying with different headers...`);
                    // Rotate user agent
                    this.axiosConfig.headers['User-Agent'] = this.getRandomUserAgent();
                    console.log(`🔄 New User-Agent: ${this.axiosConfig.headers['User-Agent'].substring(0, 50)}...`);
                    await this.sleep(3000);
                } else if (statusCode === 404) {
                    console.log(`🔍 Page not found (404) - URL may be incorrect`);
                    return null; // Don't retry 404s
                } else if (attempt === maxRetries - 1) {
                    console.error(`❌ Failed to fetch ${url} after ${maxRetries} attempts:`, error.message);
                    if (error.response) {
                        console.error(`   Response status: ${error.response.status}`);
                        console.error(`   Response headers: ${JSON.stringify(error.response.headers, null, 2)}`);
                    }
                    return null;
                } else {
                    console.log(`🔄 Attempt ${attempt + 1} failed, retrying...`);
                    await this.sleep(2000 * (attempt + 1));
                }
            }
        }
        return null;
    }

    /**
     * Get random user agent to avoid detection
     */
    getRandomUserAgent() {
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
        ];
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }

    /**
     * Validate company name
     */
    validateCompanyName(companyName) {
        if (!companyName || typeof companyName !== 'string' || companyName.trim().length === 0) {
            throw new Error('Company name must be a non-empty string');
        }
        return companyName.trim();
    }
}

// G2 Scraper Implementation
class G2Scraper extends ReviewScraper {
    constructor(delay = 2500) {
        super(delay);
        this.baseUrl = 'https://www.g2.com';
        this.browser = null;
        this.page = null;
    }

    async findChromeExecutable() {
        const possiblePaths = {
            win32: [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
                process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
                process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe'
            ],
            darwin: [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium'
            ],
            linux: [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/snap/bin/chromium'
            ]
        };

        const platform = process.platform;
        const paths = possiblePaths[platform] || possiblePaths.linux;

        for (const chromePath of paths) {
            try {
                await fs.access(chromePath);
                console.log(`✅ Found Chrome at: ${chromePath}`);
                return chromePath;
            } catch {
                continue;
            }
        }

        return null;
    }

    async launchChromeWithDebugPort(chromePath, port = 9222) {
        console.log(`🚀 Launching Chrome with debug port ${port}...`);
        
        const args = [
            `--remote-debugging-port=${port}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--start-fullscreen',
            '--user-data-dir=' + path.join(__dirname, 'chrome-profile')
        ];

        const command = `"${chromePath}" ${args.join(' ')}`;
        
        return new Promise((resolve, reject) => {
            const child = exec(command, (error) => {
                if (error) {
                    console.log('Chrome process ended');
                }
            });

            // Give Chrome time to start
            setTimeout(() => {
                console.log('✅ Chrome should be running with debug port');
                resolve(child);
            }, 3000);
        });
    }

    async connectToExistingChrome(port = 9222) {
        try {
            console.log(`🔌 Attempting to connect to Chrome on port ${port}...`);
            
            this.browser = await chromium.connectOverCDP(`http://localhost:${port}`);
            
            const contexts = this.browser.contexts();
            if (contexts.length === 0) {
                throw new Error('No browser contexts found');
            }

            const context = contexts[0];
            const pages = context.pages();
            
            if (pages.length === 0) {
                this.page = await context.newPage();
            } else {
                this.page = pages[0];
            }

            console.log('✅ Successfully connected to existing Chrome instance');
            return true;
        } catch (error) {
            console.log(`❌ Failed to connect to Chrome: ${error.message}`);
            return false;
        }
    }

    async initializeBrowser() {
        // Try to connect to existing Chrome first
        let connected = await this.connectToExistingChrome();

        if (!connected) {
            console.log('🔍 No existing Chrome debug session found. Attempting to launch Chrome...');
            
            // Try to find and launch Chrome
            const chromePath = await this.findChromeExecutable();
            
            if (chromePath) {
                await this.launchChromeWithDebugPort(chromePath);
                
                // Try connecting again
                connected = await this.connectToExistingChrome();
            } else {
                console.log('❌ Could not find Chrome executable');
            }
        }

        if (!connected) {
            console.log('\n' + '⚠️'.repeat(20));
            console.log('FALLBACK: Manual Chrome Setup Required');
            console.log('⚠️'.repeat(20));
            console.log('Please manually start Chrome with debug port:');
            console.log('');
            console.log('Windows:');
            console.log('  chrome.exe --remote-debugging-port=9222');
            console.log('');
            console.log('Mac/Linux:');
            console.log('  google-chrome --remote-debugging-port=9222');
            console.log('');
            console.log('Then restart this script.');
            throw new Error('Could not connect to Chrome');
        }

        return true;
    }

    async detectCaptcha() {
        try {
            // Check for various CAPTCHA indicators
            const captchaSelectors = [
                '.g-recaptcha',
                '#recaptcha',
                '[data-testid*="captcha"]',
                '.captcha',
                '.cf-browser-verification',
                '.challenge-running',
                'iframe[src*="recaptcha"]',
                'iframe[src*="captcha"]',
                '.cloudflare-browser-verification'
            ];

            for (const selector of captchaSelectors) {
                const element = await this.page.$(selector);
                if (element) {
                    return true;
                }
            }

            // Check for text indicators
            const content = await this.page.content();
            const captchaText = [
                'please complete the security check',
                'verify you are human',
                'prove you are not a robot',
                'complete the captcha',
                'security verification',
                'checking your browser',
                'cloudflare',
                'Verifying you are human. This may take a few seconds.',
                'just a moment while we check your browser',
            ];

            for (const text of captchaText) {
                if (content.toLowerCase().includes(text)) {
                    return true;
                }
            }

            return false;
        } catch (error) {
            console.log('Error detecting CAPTCHA:', error.message);
            return false;
        }
    }

    async waitForPageReady(expectedUrlPattern = null, maxWaitTime = 60000) {
        console.log('⏳ Waiting for page to be ready...');
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitTime) {
            try {
                await this.page.waitForTimeout(2000); // Wait 2 seconds between checks
                
                const currentUrl = this.page.url();
                const hasCaptcha = await this.detectCaptcha();
                
                // Check if CAPTCHA is resolved
                if (!hasCaptcha) {
                    // If we have an expected URL pattern, check for it
                    if (expectedUrlPattern) {
                        if (currentUrl.includes(expectedUrlPattern)) {
                            console.log(`✅ Page ready! URL contains: ${expectedUrlPattern}`);
                            return true;
                        }
                    } else {
                        // No specific URL pattern, just check that CAPTCHA is gone
                        console.log(`✅ Page ready! CAPTCHA resolved.`);
                        return true;
                    }
                }
                
                console.log(`🔄 Still waiting... Current URL: ${currentUrl.substring(0, 80)}...`);
                
            } catch (error) {
                console.log(`⚠️ Error during wait: ${error.message}`);
                await this.page.waitForTimeout(2000);
            }
        }
        
        console.log(`⏰ Wait timeout reached (${maxWaitTime/1000}s)`);
        return false;
    }

    async navigateToPage(url, expectedUrlPattern = null) {
        try {
            console.log(`🌐 Navigating to: ${url}`);
            
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // Wait a bit for initial content to load
            await this.page.waitForTimeout(3000);

            // Check for CAPTCHA and wait for resolution
            const hasCaptcha = await this.detectCaptcha();
            
            if (hasCaptcha) {
                console.log('🤖 CAPTCHA detected! Waiting for automatic resolution...');
                const ready = await this.waitForPageReady(expectedUrlPattern, 60000);
                
                if (!ready) {
                    console.log('❌ CAPTCHA was not resolved within timeout');
                    return false;
                }
            } else if (expectedUrlPattern) {
                // No CAPTCHA but check if we're on the right page
                const currentUrl = this.page.url();
                if (!currentUrl.includes(expectedUrlPattern)) {
                    console.log(`⏳ Waiting for correct page (expecting: ${expectedUrlPattern})...`);
                    const ready = await this.waitForPageReady(expectedUrlPattern, 30000);
                    
                    if (!ready) {
                        console.log('❌ Did not reach expected page within timeout');
                        return false;
                    }
                }
            }
            
            return true;
        } catch (error) {
            console.log(`❌ Navigation failed: ${error.message}`);
            return false;
        }
    }

    async getPageContent() {
        try {
            // Wait a bit for any remaining dynamic content
            await this.page.waitForTimeout(2000);
            
            // Get the full HTML content
            const htmlContent = await this.page.content();
            return htmlContent;
        } catch (error) {
            console.error('❌ Error getting page content:', error.message);
            return null;
        }
    }

    /**
     * Find G2 product page URL for a company using browser automation
     */
    async findProductUrl(companyName) {
        const cleanCompanyName = this.validateCompanyName(companyName);

        // Initialize browser connection first
        await this.initializeBrowser();

        // Use G2's search with the company name via browser
        const searchUrl = `${this.baseUrl}/search?query=${encodeURIComponent(cleanCompanyName)}`;

        console.log(`🔍 Searching G2 for: ${cleanCompanyName}`);
        
        // Navigate to search page using browser
        const navigationSuccess = await this.navigateToPage(searchUrl, '/search');
        
        if (!navigationSuccess) {
            throw new Error(`Failed to navigate to G2 search for ${cleanCompanyName}`);
        }

        // Get page content through browser
        const htmlContent = await this.getPageContent();
        
        if (!htmlContent) {
            throw new Error(`Failed to get G2 search content for ${cleanCompanyName}`);
        }

        const $ = cheerio.load(htmlContent);

        const searchResultCards = $('.elv-flex.elv-flex-col.elv-gap-y-3.elv-mb-3');
        // Get the first result (top match)
        const firstResult = searchResultCards.find('.elv-py-6.elv-px-5.lg\\:elv-px-6.elv-basis-3\\/5').first();
        const reviewLink = firstResult.find('a[href*="/products/"]');
        
        if (reviewLink.length > 0) {
            const href = reviewLink.attr('href');
            const productUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
            
            // Extract company name from the result for verification
            const companyNameInResult = firstResult.find('div.elv-tracking-normal.elv-text-default.elv-font-figtree.elv-text-lg.elv-leading-lg.elv-font-bold.active\\:elv-text-link-hover.focus\\:elv-text-link-hover.hover\\:elv-text-link-hover').text().trim();
            console.log(`✅ Found G2 URL: ${productUrl} (${companyNameInResult})`);
            return productUrl;
        }
        
        console.log(`❌ No review link found in search results`);
        return null;
    }

    /**
     * Scrape reviews from G2
     */
    async scrapeReviews(companyName, startDate, endDate, maxPages = 15) {
        console.log(`🎯 Starting G2 scraping for ${companyName}...`);
        
        const productUrl = await this.findProductUrl(companyName);
        if (!productUrl) {
            throw new Error(`Could not find G2 product page for ${companyName}`);
        }

        console.log(`✅ Found G2 product URL: ${productUrl}`);
        
        const reviews = [];
        let page = 1;
        let hasMorePages = true;
        let consecutiveEmptyPages = 0;

        while (hasMorePages && (maxPages === -1 || page <= maxPages) && consecutiveEmptyPages < 3) {
            console.log(`📄 Scraping G2 page ${page}...`);
            
            const pageUrl = `${productUrl}?order=most_recent&page=${page}`;
            
            // Navigate using browser instead of HTTP request
            const navigationSuccess = await this.navigateToPage(pageUrl, '/products/');
            
            if (!navigationSuccess) {
                console.log(`❌ Failed to navigate to G2 page ${page}`);
                consecutiveEmptyPages++;
                page++;
                continue;
            }

            // Get page content through browser
            const htmlContent = await this.getPageContent();
            
            if (!htmlContent) {
                console.log(`❌ Failed to get content from G2 page ${page}`);
                consecutiveEmptyPages++;
                page++;
                continue;
            }

            // Parse with Cheerio (your existing logic)
            const $ = cheerio.load(htmlContent);
            const reviewElements = this.findReviewElements($);
            
            if (reviewElements.length === 0) {
                console.log(`📄 No reviews found on G2 page ${page}`);
                consecutiveEmptyPages++;
                
                // Check if we hit a CAPTCHA or got blocked
                const hasCaptcha = await this.detectCaptcha();
                if (hasCaptcha) {
                    console.log('🤖 CAPTCHA detected while scraping! Waiting for resolution...');
                    const resolved = await this.waitForPageReady('/products/', 60000);
                    
                    if (resolved) {
                        // Retry the same page
                        continue;
                    } else {
                        console.log('❌ CAPTCHA resolution timeout, moving to next page');
                        page++;
                        continue;
                    }
                }
                
                page++;
                continue;
            }

            consecutiveEmptyPages = 0;
            let pageReviews = 0;
            let reviewsOutsideDateRange = 0;

            // Process reviews (your existing logic)
            reviewElements.each((i, element) => {
                const reviewData = this.extractReviewData($, element);
                if (reviewData) {
                    const reviewDate = this.parseDate(reviewData.date);
                    if (this.isDateInRange(reviewDate, startDate, endDate)) {
                        reviews.push(reviewData);
                        pageReviews++;
                    } else if (reviewDate && reviewDate < startDate) {
                        reviewsOutsideDateRange++;
                    }
                }
            });

            console.log(`📄 G2 Page ${page}: Found ${pageReviews} reviews in date range`);
            
            // Stop if we're getting too many reviews outside date range
            if (reviewsOutsideDateRange > pageReviews && page > 2) {
                console.log(`🛑 Stopping G2 scraping - reached reviews outside date range`);
                hasMorePages = false;
            } else {
                page++;
                
                // Add a small delay between pages to be respectful
                await this.page.waitForTimeout(1000);
            }
        }

        console.log(`✅ G2 scraping complete! Total reviews: ${reviews.length}`);
        console.log('🔄 Browser left open for continued use');
        
        return reviews;
    }

    /**
     * Find review elements on G2 page
     */
    findReviewElements($) {
      // First, find the main reviews container
      const $reviewsContainer = $('.elv-flex.elv-flex-col.elv-gap-2.md\\:elv-gap-6');
      if ($reviewsContainer.length === 0) {
          console.log(`⚠️ Could not find G2 reviews container`);
          return $();
      }
      const $articles = $reviewsContainer.find('article.elv-bg-neutral-0.elv-border.elv-rounded-md.md\\:elv-shadow-1.elv-border-light.elv-px-5.md\\:elv-px-6');
      if ($articles.length > 0) {
          return $articles;
      }

      console.log(`⚠️ No G2 review elements found with expected structure`);
      return $();
    }
    /**
     * Extract review data from G2 review element
     */
    extractReviewData($, element) {
        try {
            const $el = $(element);

            //Find header
            const $header = $el.find('div[class*="elv-flex"][class*="elv-flex-col"][class*="elv-justify-between"]');

            // Find reviewer
            const reviewer = $header.find('[class*="elv-font-bold"][class*="elv-text-base"][class*="elv-text-default"]').text().trim() || 'Anonymous';

            // Find Date
            let date;
            const datetime = $header.find('label[class*="elv-font-medium"][class*="elv-text-sm"][class*="elv-text-inherit"]').contents().filter((_, el) => el.type === 'text').first().text().trim();
            if (datetime) {
              // Use the ISO datetime directly - moment handles this format well
              const parsedDate = moment(datetime);
              if (parsedDate.isValid()) {
                  date = parsedDate.format('MMMM DD, YYYY');
              } else {
                  // Fallback to the raw datetime string if moment parsing fails
                  date = datetime;
              }
            }

            //Find Body
            const bodyDiv = $el.find('div[class*="elv-flex"][class*="elv-flex-col"][class*="elv-gap-y-4"]');

            // Find title
            const title = bodyDiv.find('[class*="elv-font-bold"][class*="elv-text-lg"][class*="elv-text-default"]').text().trim() || 'No title';

            // Find rating
            const rating = bodyDiv.find('.elv-tracking-normal.elv-font-figtree.elv-text-base.elv-leading-base.elv-font-semibold.elv-text-subtle').text().trim() || 'No rating';

            // Find description
            const sections = bodyDiv.find('section');

            let positive = { title: '', text: '' };
            let negative = { title: '', text: '' };

            sections.each((i, section) => {
            const $section = $(section);

            // Header div (bold text)
            const header = $section.find('.elv-tracking-normal.elv-text-default.elv-font-figtree.elv-text-base.elv-leading-base.elv-font-bold').first().text().trim();

            // All <p> tags with review content
            const paragraphs = $section.find(
              'p.elv-tracking-normal.elv-text-default.elv-font-figtree.elv-text-base.elv-leading-base'
            ).map((i, el) => $(el).text().trim()).get();

            const text = paragraphs.join('\n'); // join with newline

            // Assign based on order (0 = positive, 1 = negative)
            if (i === 0) {
              positive = { title: header, text };
            } else if (i === 1) {
              negative = { title: header, text };
            }
            });
            // Combine positive and negative into description
            const description={
              positiveTitle: positive.title,
              positiveText: positive.text,
              negativeTitle: negative.title,
              negativeText: negative.text
            }

            // Only return review if we have meaningful content
            if ((title !== 'No title' && title.length > 2) || 
                (description !== 'No description' && description.length > 10)) {
                
                return {
                    title: title,
                    description: description,
                    date: date,
                    additional_info: {
                        rating: rating,
                        reviewer: reviewer,
                        source: 'G2'
                    }
                };
            }
        }
        catch (error) {
            console.error('❌ Error extracting G2 review data:', error.message);
        }
    }
}

// Capterra Scraper Implementation with Browser Automation
class CapterraScraper extends ReviewScraper {
    constructor(delay = 2500) {
        super(delay);
        this.baseUrl = 'https://www.capterra.com';
        this.browser = null;
        this.page = null;
    }

    async findChromeExecutable() {
        const possiblePaths = {
            win32: [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
                process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
                process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe'
            ],
            darwin: [
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                '/Applications/Chromium.app/Contents/MacOS/Chromium'
            ],
            linux: [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/snap/bin/chromium'
            ]
        };

        const platform = process.platform;
        const paths = possiblePaths[platform] || possiblePaths.linux;

        for (const chromePath of paths) {
            try {
                await fs.access(chromePath);
                console.log(`✅ Found Chrome at: ${chromePath}`);
                return chromePath;
            } catch {
                continue;
            }
        }

        return null;
    }

    async launchChromeWithDebugPort(chromePath, port = 9222) {
        console.log(`🚀 Launching Chrome with debug port ${port}...`);
        
        const args = [
            `--remote-debugging-port=${port}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--start-fullscreen',
            '--user-data-dir=' + path.join(__dirname, 'chrome-profile')
        ];

        const command = `"${chromePath}" ${args.join(' ')}`;
        
        return new Promise((resolve, reject) => {
            const child = exec(command, (error) => {
                if (error) {
                    console.log('Chrome process ended');
                }
            });

            // Give Chrome time to start
            setTimeout(() => {
                console.log('✅ Chrome should be running with debug port');
                resolve(child);
            }, 3000);
        });
    }

    async connectToExistingChrome(port = 9222) {
        try {
            console.log(`🔌 Attempting to connect to Chrome on port ${port}...`);
            
            this.browser = await chromium.connectOverCDP(`http://localhost:${port}`);
            
            const contexts = this.browser.contexts();
            if (contexts.length === 0) {
                throw new Error('No browser contexts found');
            }

            const context = contexts[0];
            const pages = context.pages();
            
            if (pages.length === 0) {
                this.page = await context.newPage();
            } else {
                this.page = pages[0];
            }

            console.log('✅ Successfully connected to existing Chrome instance');
            return true;
        } catch (error) {
            console.log(`❌ Failed to connect to Chrome: ${error.message}`);
            return false;
        }
    }

    async initializeBrowser() {
        // Try to connect to existing Chrome first
        let connected = await this.connectToExistingChrome();

        if (!connected) {
            console.log('🔍 No existing Chrome debug session found. Attempting to launch Chrome...');
            
            // Try to find and launch Chrome
            const chromePath = await this.findChromeExecutable();
            
            if (chromePath) {
                await this.launchChromeWithDebugPort(chromePath);
                
                // Try connecting again
                connected = await this.connectToExistingChrome();
            } else {
                console.log('❌ Could not find Chrome executable');
            }
        }

        if (!connected) {
            console.log('\n' + '⚠️'.repeat(20));
            console.log('FALLBACK: Manual Chrome Setup Required');
            console.log('⚠️'.repeat(20));
            console.log('Please manually start Chrome with debug port:');
            console.log('');
            console.log('Windows:');
            console.log('  chrome.exe --remote-debugging-port=9222');
            console.log('');
            console.log('Mac/Linux:');
            console.log('  google-chrome --remote-debugging-port=9222');
            console.log('');
            console.log('Then restart this script.');
            throw new Error('Could not connect to Chrome');
        }

        return true;
    }

    async detectCaptcha() {
        try {
            // Check for various CAPTCHA indicators
            const captchaSelectors = [
                '.g-recaptcha',
                '#recaptcha',
                '[data-testid*="captcha"]',
                '.captcha',
                '.cf-browser-verification',
                '.challenge-running',
                'iframe[src*="recaptcha"]',
                'iframe[src*="captcha"]',
                '.cloudflare-browser-verification'
            ];
            
            for (const selector of captchaSelectors) {
                const element = await this.page.$(selector);
                if (element) {
                    return true;
                }
            }

            // Check for text indicators
            const content = await this.page.content();
            const captchaText = [
                'please complete the security check',
                'verify you are human',
                'prove you are not a robot',
                'complete the captcha',
                'security verification',
                'checking your browser',
                'Verifying you are human. This may take a few seconds.',
                'Verify you are human by completing the action below.',
                'browser verification',
                'security check'
            ];
            
            for (const text of captchaText) {
                if (content.toLowerCase().includes(text)) {
                    return true;
                }
            }

            return false;
        } catch (error) {
            console.log('Error detecting CAPTCHA:', error.message);
            return false;
        }
    }

    async waitForPageReady(expectedUrlPattern = null, maxWaitTime = 60000) {
        console.log('⏳ Waiting for page to be ready...');
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitTime) {
            try {
                await this.page.waitForTimeout(2000); // Wait 2 seconds between checks
                
                const currentUrl = this.page.url();
                const hasCaptcha = await this.detectCaptcha();
                
                // Check if CAPTCHA is resolved
                if (!hasCaptcha) {
                    // If we have an expected URL pattern, check for it
                    if (expectedUrlPattern) {
                        if (currentUrl.includes(expectedUrlPattern)) {
                            console.log(`✅ Page ready! URL contains: ${expectedUrlPattern}`);
                            return true;
                        }
                    } else {
                        // No specific URL pattern, just check that CAPTCHA is gone
                        console.log(`✅ Page ready! CAPTCHA resolved.`);
                        return true;
                    }
                }
                
                console.log(`🔄 Still waiting... Current URL: ${currentUrl.substring(0, 80)}...`);
                
            } catch (error) {
                console.log(`⚠️ Error during wait: ${error.message}`);
                await this.page.waitForTimeout(2000);
            }
        }
        
        console.log(`⏰ Wait timeout reached (${maxWaitTime/1000}s)`);
        return false;
    }

    async navigateToPage(url, expectedUrlPattern = null) {
        try {
            console.log(`🌐 Navigating to: ${url}`);
            
            await this.page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });

            // Wait a bit for initial content to load
            await this.page.waitForTimeout(3000);

            // Check for CAPTCHA and wait for resolution
            const hasCaptcha = await this.detectCaptcha();
            
            if (hasCaptcha) {
                console.log('🤖 CAPTCHA detected! Waiting for automatic resolution...');
                const ready = await this.waitForPageReady(expectedUrlPattern, 60000);
                
                if (!ready) {
                    console.log('❌ CAPTCHA was not resolved within timeout');
                    return false;
                }
            } else if (expectedUrlPattern) {
                // No CAPTCHA but check if we're on the right page
                const currentUrl = this.page.url();
                if (!currentUrl.includes(expectedUrlPattern)) {
                    console.log(`⏳ Waiting for correct page (expecting: ${expectedUrlPattern})...`);
                    const ready = await this.waitForPageReady(expectedUrlPattern, 30000);
                    
                    if (!ready) {
                        console.log('❌ Did not reach expected page within timeout');
                        return false;
                    }
                }
            }
            
            return true;
        } catch (error) {
            console.log(`❌ Navigation failed: ${error.message}`);
            return false;
        }
    }

    async getPageContent() {
        try {
            // Wait a bit for any remaining dynamic content
            await this.page.waitForTimeout(2000);
            
            // Get the full HTML content
            const htmlContent = await this.page.content();
            return htmlContent;
        } catch (error) {
            console.error('❌ Error getting page content:', error.message);
            return null;
        }
    }

    /**
     * Find Capterra product page URL for a company using browser automation
     */
    async findProductUrl(companyName) {
        const cleanCompanyName = this.validateCompanyName(companyName);

        // Initialize browser connection first
        await this.initializeBrowser();

        // Use Capterra's search with the company name via browser
        const searchUrl = `${this.baseUrl}/search/?query=${encodeURIComponent(cleanCompanyName)}`;

        console.log(`🔍 Searching Capterra for: ${cleanCompanyName}`);
        
        // Navigate to search page using browser - check for query parameter instead
        const navigationSuccess = await this.navigateToPage(searchUrl, `query=${encodeURIComponent(cleanCompanyName)}`);
        
        if (!navigationSuccess) {
            throw new Error(`Failed to navigate to Capterra search for ${cleanCompanyName}`);
        }

        // Get page content through browser
        const htmlContent = await this.getPageContent();
        
        if (!htmlContent) {
            throw new Error(`Failed to get Capterra search content for ${cleanCompanyName}`);
        }

        const $ = cheerio.load(htmlContent);

        // Look for product links in search results
        const searchResultCards = $('[data-testid="search-product-card"]');
        
        if (searchResultCards.length === 0) {
            console.log(`⚠️ No search result cards found. Checking for CAPTCHA...`);
            
            // Check if CAPTCHA is blocking the results
            const hasCaptcha = await this.detectCaptcha();
            
            if (hasCaptcha) {
                console.log('🤖 CAPTCHA detected on search page! Please solve it manually in the browser.');
                console.log('💡 The browser window should be open. Complete the verification and the script will continue.');
                
                const resolved = await this.waitForPageReady(`query=${encodeURIComponent(cleanCompanyName)}`, 120000); // 2 minute timeout
                
                if (resolved) {
                    console.log('✅ CAPTCHA resolved! Retrying search...');
                    
                    // Get updated content after CAPTCHA resolution
                    const updatedHtmlContent = await this.getPageContent();
                    
                    if (updatedHtmlContent) {
                        const $updated = cheerio.load(updatedHtmlContent);
                        const updatedSearchResultCards = $updated('[data-testid="search-product-card"]');
                        
                        if (updatedSearchResultCards.length > 0) {
                            const firstResult = updatedSearchResultCards.first();
                            const reviewLink = firstResult.find('a[href^="https://www.capterra.com/p/"]');
                            
                            if (reviewLink.length > 0) {
                                const href = reviewLink.attr('href');
                                const reviewUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
                                const productUrl = reviewUrl.replace(/\/$/, '') + '/reviews/?page=1';

                                console.log(`✅ Found Capterra URL after CAPTCHA resolution: ${productUrl}`);
                                return productUrl;
                            }
                        }
                    }
                }
                
                console.log('❌ CAPTCHA was not resolved or no results found after resolution');
                return null;
            }
            
            console.log(`❌ No search results found and no CAPTCHA detected`);
            return null;
        }
        
        const firstResult = searchResultCards.first();
        const reviewLink = firstResult.find('a[href^="https://www.capterra.com/p/"]');
        
        if (reviewLink.length > 0) {
            const href = reviewLink.attr('href');
            const reviewUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
            const productUrl = reviewUrl.replace(/\/$/, '') + '/reviews/?page=1';

            // Extract company name from the result for verification
            const companyNameInResult = firstResult.find('.CAPTERRA_COMPANY_NAME_SELECTOR').text().trim(); // Replace with actual selector
            console.log(`✅ Found Capterra URL: ${productUrl} (${companyNameInResult})`);
            return productUrl;
        }
        
        console.log(`❌ No review link found in search results`);
        return null;
    }

    /**
     * Scrape reviews from Capterra
     */
    async scrapeReviews(companyName, startDate, endDate, maxPages = 15) {
        console.log(`🎯 Starting Capterra scraping for ${companyName}...`);
        
        // Initialize browser connection
        await this.initializeBrowser();

        const productUrl = await this.findProductUrl(companyName);
        if (!productUrl) {
            throw new Error(`Could not find Capterra product page for ${companyName}`);
        }

        console.log(`✅ Found Capterra product URL: ${productUrl}`);
        
        const reviews = [];
        let page = 1;
        let hasMorePages = true;
        let consecutiveEmptyPages = 0;

        while (hasMorePages && (maxPages === -1 || page <= maxPages) && consecutiveEmptyPages < 1) {
            console.log(`📄 Scraping Capterra page ${page}...`);
            
            const pageUrl = `${productUrl}?page=${page}`; // Adjust pagination URL format as needed
            
            // Navigate using browser instead of HTTP request
            const navigationSuccess = await this.navigateToPage(pageUrl, '/p/');
            
            if (!navigationSuccess) {
                console.log(`❌ Failed to navigate to Capterra page ${page}`);
                consecutiveEmptyPages++;
                page++;
                continue;
            }

            // Set sort to most recent
            if (page === 1) {
                await this.setSortToMostRecent();
            }

            // Expand all "Read More" buttons before extracting content
            await this.expandAllReadMoreButtons();

            // Get page content through browser
            const htmlContent = await this.getPageContent();
            
            if (!htmlContent) {
                console.log(`❌ Failed to get content from Capterra page ${page}`);
                consecutiveEmptyPages++;
                page++;
                continue;
            }

            // Parse with Cheerio
            const $ = cheerio.load(htmlContent);
            const reviewElements = this.findReviewElements($);
            
            if (reviewElements.length === 0) {
                console.log(`📄 No reviews found on Capterra page ${page}`);
                consecutiveEmptyPages++;
                
                // Check if we hit a CAPTCHA or got blocked
                const hasCaptcha = await this.detectCaptcha();
                if (hasCaptcha) {
                    console.log('🤖 CAPTCHA detected while scraping! Waiting for resolution...');
                    const resolved = await this.waitForPageReady('/p/', 60000);
                    
                    if (resolved) {
                        // Retry the same page
                        continue;
                    } else {
                        console.log('❌ CAPTCHA resolution timeout, moving to next page');
                        page++;
                        continue;
                    }
                }
                
                page++;
                continue;
            }

            consecutiveEmptyPages = 0;
            let pageReviews = 0;
            let reviewsOutsideDateRange = 0;

            // Process reviews
            reviewElements.each((i, element) => {
                const reviewData = this.extractReviewData($, element);
                if (reviewData) {
                    const reviewDate = this.parseDate(reviewData.date);
                    if (this.isDateInRange(reviewDate, startDate, endDate)) {
                        reviews.push(reviewData);
                        pageReviews++;
                    } else if (reviewDate && reviewDate < startDate) {
                        reviewsOutsideDateRange++;
                    }
                }
            });

            console.log(`📄 Capterra Page ${page}: Found ${pageReviews} reviews in date range`);
            
            // Stop if we're getting too many reviews outside date range
            if (reviewsOutsideDateRange > pageReviews && page > 2) {
                console.log(`🛑 Stopping Capterra scraping - reached reviews outside date range`);
                hasMorePages = false;
            } else {
                page++;
                
                // Add a small delay between pages to be respectful
                await this.page.waitForTimeout(1000);
            }
        }

        console.log(`✅ Capterra scraping complete! Total reviews: ${reviews.length}`);
        console.log('🔄 Browser left open for continued use');
        
        return reviews;
    }

    /**
     * Find review elements on Capterra page
     */
    findReviewElements($) {
        const $reviewsContainer = $('[data-test-id="review-cards-container"]');
        if ($reviewsContainer.length === 0) {
            console.log(`⚠️ Could not find Capterra reviews container`);
            return $();
        }
        
        let $reviews = $reviewsContainer.find('div[class*="typo-10"][class*="mb-6"][class*="p-6"]');
        if ($reviews.length > 0) {
            return $reviews;
        }
        $reviews = $reviewsContainer.find('div[class*="flex"][class*="flex-col"]'); // fallback selector
        if ($reviews.length > 0) {
            return $reviews;
        }

        console.log(`⚠️ No Capterra review elements found with expected structure`);
        return $();
    }

    /**
     * Expand all "Read More" buttons on the page by clicking them
     */
    async expandAllReadMoreButtons() {
        try {
            console.log('🔍 Looking for "continue-reading-button" elements...');
            
            // Find all continue-reading-button elements
            const readMoreButtons = await this.page.$$('[data-testid="continue-reading-button"]');
            
            if (readMoreButtons.length === 0) {
                console.log('📄 No "Read More" buttons found');
                return;
            }
            
            console.log(`📄 Found ${readMoreButtons.length} "Read More" buttons to expand`);
            
            // Simple approach: just click each button directly
            for (let i = 1; i < readMoreButtons.length; i++) { //first one pre expanded
                try {
                    console.log(`📄 Clicking "Read More" button ${i + 1}/${readMoreButtons.length}`);
                    await readMoreButtons[i].click();
                    
                    // Small delay after clicking to let content expand
                    await this.page.waitForTimeout(Math.floor(Math.random() * 101) + 100);
                } catch (error) {
                    console.log(`⚠️ Failed to click button ${i + 1}: ${error.message}`);
                    // Continue with next button even if one fails
                }
            }
            await this.page.waitForTimeout(300); // Wait a bit after all clicks
            console.log('✅ Finished expanding all "Read More" buttons');
            
        } catch (error) {
            console.log(`❌ Error expanding read more buttons: ${error.message}`);
        }
    }

    /** set sort to most recent */
    async setSortToMostRecent() {
        try {
            console.log('🔄 Setting sort to most recent...');
            await this.page.click('[data-testid="filters-sort-by"]'); //fullscreen
            await this.page.waitForTimeout(100);
            await this.page.click('button.e1xzmg0z.byb7w84.sli6p0m'); //not fullscreen
            await this.page.waitForTimeout(95);
            await this.page.click('[data-testid="filter-sort-MOST_RECENT"]');
            await this.page.waitForTimeout(105);
            await this.page.click('button.e1xzmg0z.l17grxq6'); //not fullscreen
            await this.page.waitForTimeout(110);
            await this.page.click('i[data-modal-role="close-button"]'); //close for not fullscreen
            
            await this.page.waitForTimeout(400);
            console.log('✅ Sort set to most recent');
        } catch (error) {
            console.log(`❌ Error setting sort to most recent: ${error.message}`);
        }
    }

    /**
     * Extract review data from Capterra review element
     */
    extractReviewData($, element) {
        try {
            const $el = $(element);

            // Find reviewer

            const $reviewer= $el.find('div[class*="typo-10"][class*="text-neutral-90"][class*="w-full"][class*="lg:w-fit"]');

            let reviewerName = 'Anonymous Verified Reviewer';
            const reviewerAttributes = [];
            $reviewer.contents().each((i, node) => {
                if (node.tagName === 'span'){
                  reviewerName = $(node).text().trim();
                }

                // For text nodes
                if (node.type === 'text') {
                    const text = node.data.trim();
                    if (text) reviewerAttributes.push(text);
                }
            });
            
            // Find title
            const title = $el.find('h3[class*="typo-20"][class*="font-semibold"]').text().trim() || 'No title';

            //Find Date
            let date;
            const datetime = $el.find('.typo-0.text-neutral-90').text().trim();
            if (datetime) {
              // Use the ISO datetime directly - moment handles this format well
              const parsedDate = moment(datetime);
              if (parsedDate.isValid()) {
                  date = parsedDate.format('MMMM DD, YYYY');
              } else {
                  // Fallback to the raw datetime string if moment parsing fails
                  date = datetime;
              }
            }
            console.log(`Review date: ${date}`);
            
            // Find rating
            const rating = $el.find('.e1xzmg0z.sr2r3oj').text().trim() || 'No rating';

            // Find description
            const description = $el.find('div[class*="!mt-4"][class*="space-y-6"] p').text().trim() || '';
            
            const texts = [];
            const expandedDiv = $el.find('div[class*="space-y-4"][class*="lg:space-y-6"] > div[class="space-y-6"]');
            expandedDiv.children().slice(0, -2).each((i, elem) => {
              const text = $(elem).text().trim();
              if (text && text !== 'Continue Reading') {
               texts.push(text);
              }
               });
             const expandedDescription = texts.join('\n');


            // Only return review if we have meaningful content
            if ((title !== 'No title' && title.length > 2) || 
                (description !== 'No description' && description.length > 10)) {
                
                return {
                    title: title,
                    description: description,
                    expandedDescription: expandedDescription,
                    date: date,
                    additional_info: {
                        rating: rating,
                        reviewerName: reviewerName,
                        reviewerAttributes: reviewerAttributes.join(' | '),
                        source: 'Capterra'
                    }
                };
            }
        }
        catch (error) {
            console.error('❌ Error extracting Capterra review data:', error.message);
        }
        return null;
    }
}

// TrustPilot Scraper Implementation - Fixed based on actual HTML structure
class TrustPilotScraper extends ReviewScraper {
    constructor(delay = 2500) {
        super(delay);
        this.baseUrl = 'https://www.trustpilot.com';
    }

    /**
     * Find TrustPilot company page using search results - pick first result
     */
    async findProductUrl(companyName) {
        const cleanCompanyName = this.validateCompanyName(companyName);
        
        // Use TrustPilot's search with the company name
        const searchUrl = `${this.baseUrl}/search?query=${encodeURIComponent(cleanCompanyName)}`;
        
        console.log(`🔍 Searching TrustPilot for: ${cleanCompanyName}`);
        const response = await this.safeRequest(searchUrl);
        
        if (!response) {
            throw new Error(`Failed to search TrustPilot for ${cleanCompanyName}`);
        }

        const $ = cheerio.load(response.data);
        
        // Look for search result cards with the structure from your HTML
        // Each result is in a div with class "CDS_Card_card__16d1cc styles_card__WMwue"
        const searchResultCards = $('.CDS_Card_card__16d1cc.styles_card__WMwue');
        
        if (searchResultCards.length === 0) {
            console.log(`❌ No search results found for ${cleanCompanyName}`);
            return null;
        }
        
        console.log(`📍 Found ${searchResultCards.length} search results`);
        
        // Get the first result (top match)
        const firstResult = searchResultCards.first();
        const reviewLink = firstResult.find('a[href*="/review/"]');
        
        if (reviewLink.length > 0) {
            const href = reviewLink.attr('href');
            const productUrl = href.startsWith('http') ? href : `${this.baseUrl}${href}`;
            
            // Extract company name from the result for verification
            const companyNameInResult = firstResult.find('.CDS_Typography_heading-s__96c1da').text().trim();
            console.log(`✅ Found TrustPilot URL: ${productUrl} (${companyNameInResult})`);
            
            return productUrl;
        }
        
        console.log(`❌ No review link found in search results`);
        return null;
    }

    /**
     * Scrape reviews from TrustPilot based on actual HTML structure
     */
    async scrapeReviews(companyName, startDate, endDate, maxPages = 10) {
        console.log(`Starting TrustPilot scraping for ${companyName}...`);
        
        const productUrl = await this.findProductUrl(companyName);
        if (!productUrl) {
            throw new Error(`Could not find TrustPilot page for ${companyName}`);
        }

        console.log(`✅ Found TrustPilot URL: ${productUrl}`);
        
        const reviews = [];
        let page = 1;
        let hasMorePages = true;
        let consecutiveEmptyPages = 0;

        while (hasMorePages && (maxPages === -1 || page <= maxPages) && consecutiveEmptyPages < 3) {
            console.log(`📄 Scraping TrustPilot page ${page}...`);
            
            // Construct page URL - page 1 redirects to base URL, so handle that
            const pageUrl = page === 1 ? productUrl : `${productUrl}?page=${page}`;
            const response = await this.safeRequest(pageUrl);
            
            if (!response) {
                console.log(`❌ Failed to fetch TrustPilot page ${page}`);
                consecutiveEmptyPages++;
                page++;
                continue;
            }

            const $ = cheerio.load(response.data);
            const reviewElements = this.findReviewElements($);
            
            if (reviewElements.length === 0) {
                console.log(`📄 No reviews found on TrustPilot page ${page}`);
                consecutiveEmptyPages++;
                page++;
                continue;
            }

            consecutiveEmptyPages = 0;
            let pageReviews = 0;
            let reviewsOutsideDateRange = 0;

            reviewElements.each((i, element) => {
                const reviewData = this.extractReviewData($, element);
                if (reviewData) {
                    const reviewDate = this.parseDate(reviewData.date);
                    if (this.isDateInRange(reviewDate, startDate, endDate)) {
                        reviews.push(reviewData);
                        pageReviews++;
                    } else if (reviewDate && reviewDate < startDate) {
                        reviewsOutsideDateRange++;
                    }
                }
            });

            console.log(`📄 TrustPilot Page ${page}: Found ${pageReviews} reviews in date range`);
            
            // Stop if we're getting too many reviews outside date range
            if (reviewsOutsideDateRange > pageReviews && page > 2) {
                console.log(`🛑 Stopping TrustPilot scraping - reached reviews outside date range`);
                hasMorePages = false;
            } else {
                page++;
            }
        }

        console.log(`✅ TrustPilot scraping complete! Total reviews: ${reviews.length}`);
        return reviews;
    }

    /**
     * Find review elements using the correct selectors based on actual HTML structure
     */
    findReviewElements($) {
        // First, find the main reviews container
        const reviewsContainer = $('.styles_reviewListContainer__2bg_p .styles_wrapper__Fi9KX');
        
        if (reviewsContainer.length === 0) {
            console.log(`⚠️ Could not find TrustPilot reviews container`);
            return $();
        }
        
        // Find individual review cards within the container
        const reviewElements = reviewsContainer.find('.styles_cardWrapper__g8amG.styles_show__Z8n7u');
        
        if (reviewElements.length > 0) {
            return reviewElements;
        }
        
        console.log(`⚠️ No TrustPilot review elements found with expected structure`);
        return $();
    }

    /**
     * Extract review data based on the actual HTML structure provided
     */
    extractReviewData($, element) {
        try {
            const $el = $(element);
            
            // Find the article element within this review card
            const $article = $el.find('article.styles_reviewCard__Qwhpy');
            if ($article.length === 0) {
                return null;
            }
            
            // Find the main content div
            const $reviewDiv = $article.find('[data-testid="service-review-card-v2"]');
            if ($reviewDiv.length === 0) {
                return null;
            }

            // Extract reviewer name
            const reviewerNameEl = $reviewDiv.find('span.styles_consumerName__xKr9c');
            const reviewer = reviewerNameEl.text().trim() || 'Anonymous';
            
            // Extract rating from the data attribute
            const ratingDiv = $reviewDiv.find('.styles_reviewHeader__DzoAZ[data-service-review-rating]');
            let rating = 'No rating';
            if (ratingDiv.length > 0) {
                const ratingValue = ratingDiv.attr('data-service-review-rating');
                if (ratingValue) {
                    rating = `${ratingValue}/5 stars`;
                }
            }
            
            // Extract title
            const titleEl = $reviewDiv.find('h2[data-service-review-title-typography="true"]');
            const title = titleEl.text().trim() || 'No title';
            
            // Extract description
            const descriptionEl = $reviewDiv.find('p[data-service-review-text-typography="true"]');
            const description = descriptionEl.text().trim() || 'No description';
            
            // Extract date from the time element with datetime attribute
            let date = 'Unknown';
            const timeEl = $reviewDiv.find('time[datetime]');
            
            if (timeEl.length > 0) {
                const datetime = timeEl.attr('datetime');
                if (datetime) {
                    // Use the ISO datetime directly - moment handles this format well
                    const parsedDate = moment(datetime);
                    if (parsedDate.isValid()) {
                        date = parsedDate.format('MMMM DD, YYYY');
                    } else {
                        // Fallback to the raw datetime string if moment parsing fails
                        date = datetime;
                    }
                }
            }
            
            // If no datetime attribute found, try to get from the badge as fallback
            if (date === 'Unknown') {
                const dateBadge = $reviewDiv.find('.CDS_Badge_badgeText__5cd9fd');
                dateBadge.each((i, badge) => {
                    const badgeText = $(badge).text().trim();
                    // Look for date patterns like "August 7, 2025" or "February 15, 2025"
                    if (badgeText.match(/^[A-Za-z]+ \d{1,2}, \d{4}$/)) {
                        date = badgeText;
                        return false; // break the loop
                    }
                });
            }

            // Only return review if we have meaningful content
            if ((title !== 'No title' && title.length > 2) || 
                (description !== 'No description' && description.length > 10)) {
                
                return {
                    title: title,
                    description: description,
                    date: date,
                    additional_info: {
                        rating: rating,
                        reviewer: reviewer,
                        source: 'TrustPilot'
                    }
                };
            }
        } catch (error) {
            console.error('❌ Error extracting TrustPilot review data:', error.message);
        }
        return null;
    }
}

// Main execution function
async function main() {
    console.log('SaaS Review Scraper is Running...\n');

    program
        .name('saas-review-scraper')
        .description('SaaS product review scraper for G2, Capterra, and TrustPilot')
        .requiredOption('-c, --company <company>', 'Company name to scrape reviews for')
        .requiredOption('-s, --start-date <date>', 'Start date (YYYY-MM-DD)')
        .requiredOption('-e, --end-date <date>', 'End date (YYYY-MM-DD)')
        .requiredOption('-r, --source <source>', 'Review source (g2, capterra, trustpilot, all)')
        .option('-o, --output <file>', 'Output JSON file path', 'reviews.json')
        .option('-d, --delay <ms>', 'Delay between requests in milliseconds', '2500')
        .option('--max-pages <num>', 'Maximum pages to scrape per source [-1 for all pages]', '15')
        .parse();

    const options = program.opts();

    try {
        // Validate dates
        const startDate = moment(options.startDate, 'YYYY-MM-DD', true);
        const endDate = moment(options.endDate, 'YYYY-MM-DD', true);

        if (!startDate.isValid() || !endDate.isValid()) {
            throw new Error('Invalid date format. Use YYYY-MM-DD (e.g., 2024-01-15)');
        }

        if (startDate.isAfter(endDate)) {
            throw new Error('Start date must be before or equal to end date');
        }

        if (startDate.isAfter(moment())) {
            throw new Error('Start date cannot be in the future');
        }

        const startDateObj = startDate.toDate();
        const endDateObj = endDate.toDate();

        // Initialize scrapers
        const delay = parseInt(options.delay);
        const maxPages = parseInt(options.maxPages);
        const scrapers = {
            'g2': new G2Scraper(delay),
            'capterra': new CapterraScraper(delay),
            'trustpilot': new TrustPilotScraper(delay)
        };

        // Validate source
        const validSources = ['g2', 'capterra', 'trustpilot', 'all'];
        if (!validSources.includes(options.source)) {
            throw new Error(`Invalid source. Choose from: ${validSources.join(', ')}`);
        }

        // Determine which sources to scrape
        const sourcesToScrape = options.source === 'all' ? 
            ['g2', 'capterra', 'trustpilot'] : [options.source];

        console.log(`Scraping Configuration:`);
        console.log(`Company: ${options.company}`);
        console.log(`Date Range: ${options.startDate} to ${options.endDate}`);
        console.log(`Sources: ${sourcesToScrape.join(', ')}`);
        console.log(`Output: ${options.output}`);
        console.log(`Delay: ${delay}ms`);
        console.log(`Max Pages: ${maxPages}\n`);

        const allReviews = [];
        const scrapingResults = {};

        // Scrape from each source
        for (const source of sourcesToScrape) {
            try {
                console.log(`\nStarting ${source.toUpperCase()} scraping...`);
                const scraper = scrapers[source];
                const reviews = await scraper.scrapeReviews(options.company, startDateObj, endDateObj, maxPages);
                
                allReviews.push(...reviews);
                scrapingResults[source] = {
                    success: true,
                    count: reviews.length,
                    error: null
                };
                
                console.log(`${source.toUpperCase()}: ${reviews.length} reviews collected`);
                
            } catch (error) {
                console.error(`❌ ${source.toUpperCase()} scraping failed:`, error.message);
                scrapingResults[source] = {
                    success: false,
                    count: 0,
                    error: error.message
                };
            }
        }

        // Prepare output data with comprehensive metadata
        const outputData = {
            metadata: {
                company: options.company,
                sources_requested: sourcesToScrape,
                start_date: options.startDate,
                end_date: options.endDate,
                total_reviews: allReviews.length,
                scraped_at: moment().toISOString(),
                scraping_duration: `${Date.now() - startTime}ms`,
                scraper_version: '1.0.0',
                scraping_results: scrapingResults
            },
            reviews: allReviews.sort((a, b) => {
                const dateA = moment(a.date);
                const dateB = moment(b.date);
                return dateB.isValid() && dateA.isValid() ? dateB.diff(dateA) : 0;
            })
        };

        // Save to JSON file
        const outputPath = path.resolve(options.output);
        await fs.writeFile(outputPath, JSON.stringify(outputData, null, 2), 'utf8');
        
        console.log(`\nScraping Complete!`);
        console.log(`Summary:`);
        console.log(`Total Reviews: ${allReviews.length}`);
        console.log(`Output File: ${outputPath}`);
        console.log(`File Size: ${(JSON.stringify(outputData).length / 1024).toFixed(2)} KB`);
        
        // Display source breakdown
        console.log(`\nSource Breakdown:`);
        for (const [source, result] of Object.entries(scrapingResults)) {
            const status = result.success ? 'Success!' : 'Failed';
            console.log(`${status} ${source.toUpperCase()}: ${result.count} reviews`);
            if (!result.success) {
                console.log(`   Error: ${result.error}`);
            }
        }
        
        // Display sample review if available
        if (allReviews.length > 0) {
            console.log(`\n📝 Sample Review:`);
            const sample = allReviews[0];
            console.log(`   Title: ${sample.title.substring(0, 60)}${sample.title.length > 60 ? '...' : ''}`);
            console.log(`   Source: ${sample.additional_info.source}`);
            console.log(`   Date: ${sample.date}`);
            console.log(`   Rating: ${sample.additional_info.rating}`);
        }

        // Performance metrics
        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;
        console.log(`\n⏱️  Total execution time: ${duration.toFixed(2)} seconds`);
        
        if (allReviews.length === 0) {
            console.log(`\nNo reviews found. This could be due to:`);
            console.log(`   • Company name not found on selected sources`);
            console.log(`   • No reviews in the specified date range`);
            console.log(`   • Website structure changes blocking scraping`);
            console.log(`   • Rate limiting or access restrictions`);
            process.exit(1);
        }

    } catch (error) {
        console.error('\nScraping failed:', error.message);
        console.log('\nTroubleshooting tips:');
        console.log('   • Verify company name spelling');
        console.log('   • Check date format (YYYY-MM-DD)');
        console.log('   • Ensure internet connection is stable');
        console.log('   • Try increasing delay with --delay option');
        process.exit(1);
    }
}

// Track execution time
const startTime = Date.now();

// Run the script
if (require.main === module) {
    main().catch(error => {
        console.error('💥 Unexpected error:', error);
        process.exit(1);
    });
}

// Export classes for testing
module.exports = { 
    G2Scraper, 
    CapterraScraper, 
    TrustPilotScraper,
    ReviewScraper 
};
