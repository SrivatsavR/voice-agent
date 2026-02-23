import { tool } from '@openai/agents';
import { z } from 'zod';

// ─── Indian State Codes for GSTIN ─────────────────────────────────────────────

const VALID_STATE_CODES = {
    '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
    '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
    '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
    '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
    '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram',
    '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam',
    '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha',
    '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
    '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
    '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep',
    '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
    '35': 'Andaman & Nicobar Islands', '36': 'Telangana',
    '37': 'Andhra Pradesh', '38': 'Ladakh',
    '97': 'Other Territory', '99': 'Centre Jurisdiction',
};

// ─── GSTIN checksum calculation ───────────────────────────────────────────────

function computeGSTINChecksum(gstin14) {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let sum = 0;
    for (let i = 0; i < 14; i++) {
        const idx = chars.indexOf(gstin14[i]);
        const factor = (i % 2 === 0) ? 1 : 2;
        const product = idx * factor;
        sum += Math.floor(product / 36) + (product % 36);
    }
    const remainder = sum % 36;
    const checkChar = chars[(36 - remainder) % 36];
    return checkChar;
}

// ─── Email Validation Tool ────────────────────────────────────────────────────

export const validateEmailTool = tool({
    name: 'validate_email',
    description: 'Validates an email address for correct format. Use this tool after collecting an email from the caller to verify it is valid before proceeding.',
    parameters: z.object({
        email: z.string().describe('The email address to validate (already normalized from speech)')
    }),
    execute: async ({ email }) => {
        const normalized = email.trim().toLowerCase();

        // RFC 5322 simplified email regex
        const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
        const valid = emailRegex.test(normalized);

        const result = { valid, normalized };

        if (!valid) {
            // Provide helpful error context
            if (!normalized.includes('@')) {
                result.error = 'Missing @ symbol. Ask the caller to repeat the email and listen for "at" or "at the rate".';
            } else if (!normalized.includes('.')) {
                result.error = 'Missing domain extension (e.g. .com, .in). Ask the caller to complete the email.';
            } else {
                result.error = 'Invalid email format. Ask the caller to spell it out slowly, letter by letter.';
            }
        } else {
            // Common Indian email domains — check for typos
            const domain = normalized.split('@')[1];
            const suggestions = {
                'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmaill.com': 'gmail.com',
                'gamil.com': 'gmail.com', 'gmale.com': 'gmail.com',
                'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yhaoo.com': 'yahoo.com',
                'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com',
                'outlok.com': 'outlook.com', 'outllook.com': 'outlook.com',
                'redifmail.com': 'rediffmail.com', 'reddiffmail.com': 'rediffmail.com',
            };
            if (suggestions[domain]) {
                result.suggestion = `Did you mean ${normalized.split('@')[0]}@${suggestions[domain]}? Common typo detected in domain.`;
                result.suggested_email = `${normalized.split('@')[0]}@${suggestions[domain]}`;
            }
        }
        return result; // RETURN OBJECT DIRECTLY so tool callers don't have to JSON.parse
    }
});

// ─── Spoken Email Normalizer Tool ─────────────────────────────────────────────

export const normalizeSpokenEmailTool = tool({
    name: 'normalize_spoken_email',
    description: 'Converts a speech-transcribed email into proper email format. Handles "at" → @, "dot" → ., spelled-out letters, etc. Use this tool BEFORE validate_email when the caller dictates their email address.',
    parameters: z.object({
        spoken_email: z.string().describe('The raw ASR transcript of the caller speaking their email address')
    }),
    execute: async ({ spoken_email }) => {
        let email = spoken_email.trim().toLowerCase();

        // Common ASR speech-to-email normalizations
        email = email
            .replace(/\s+at\s+the\s+rate\s+(of\s+)?/gi, '@')
            .replace(/\s+at\s+/gi, '@')
            .replace(/\s+dot\s+/gi, '.')
            .replace(/\s+dash\s+/gi, '-')
            .replace(/\s+underscore\s+/gi, '_')
            .replace(/\s+hyphen\s+/gi, '-')
            // Handle individual letter spelling: "r o h i t" → "rohit"
            .replace(/(?:^|\s)([a-z])\s+(?=[a-z]\s|[a-z]$)/gi, '$1')
            // Remove remaining spaces (spelled-out chars already joined)
            .replace(/\s+/g, '');

        // Common Indian domain shortcuts
        email = email
            .replace(/@gmail$/i, '@gmail.com')
            .replace(/@yahoo$/i, '@yahoo.com')
            .replace(/@hotmail$/i, '@hotmail.com')
            .replace(/@outlook$/i, '@outlook.com')
            .replace(/@rediffmail$/i, '@rediffmail.com')
            .replace(/@rediff$/i, '@rediffmail.com');

        return { normalized_email: email };
    }
});

// validateGSTINTool removed as per user request

// ─── Indian Phone Number Validation Tool ──────────────────────────────────────

export const validatePhoneTool = tool({
    name: 'validate_phone',
    description: 'Validates an Indian mobile phone number. Strips country code (+91) if present. Indian mobile numbers are 10 digits starting with 6, 7, 8, or 9.',
    parameters: z.object({
        phone: z.string().describe('The phone number to validate')
    }),
    execute: async ({ phone }) => {
        // Strip everything except digits
        let digits = phone.replace(/[^0-9]/g, '');

        // Remove leading country code
        if (digits.startsWith('91') && digits.length === 12) {
            digits = digits.substring(2);
        } else if (digits.startsWith('0') && digits.length === 11) {
            digits = digits.substring(1);
        }

        const result = { normalized: digits };

        if (digits.length !== 10) {
            result.valid = false;
            result.error = `Expected 10-digit mobile number, got ${digits.length} digits.`;
        } else if (!/^[6-9]/.test(digits)) {
            result.valid = false;
            result.error = 'Indian mobile numbers must start with 6, 7, 8, or 9.';
        } else {
            result.valid = true;
            result.formatted = `+91 ${digits.substring(0, 5)} ${digits.substring(5)}`;
        }
        return result;
    }
});

// ─── Price Range Validation Tool ──────────────────────────────────────────────

export const validatePriceRangeTool = tool({
    name: 'validate_price_range',
    description: 'Validates a price range (min and max in INR). Checks that both are positive numbers and that min <= max. If min > max, suggests a swap.',
    parameters: z.object({
        price_min: z.number().describe('The minimum price in INR'),
        price_max: z.number().describe('The maximum price in INR')
    }),
    execute: async ({ price_min, price_max }) => {
        const result = {};

        if (price_min < 0 || price_max < 0) {
            result.valid = false;
            result.error = 'Prices cannot be negative. Ask the caller to confirm the amounts.';
            return result;
        }

        if (price_min === 0 && price_max === 0) {
            result.valid = false;
            result.error = 'Both prices are zero. Ask the caller to provide their actual selling price range.';
            return result;
        }

        if (price_min > price_max) {
            result.valid = true;
            result.swapped = true;
            result.price_min = price_max;
            result.price_max = price_min;
            result.note = `Swapped min and max since ${price_min} > ${price_max}. Confirm with the caller: "Just to confirm, your price range is ₹${price_max} to ₹${price_min}?"`;
            return result;
        }

        // Meesho-specific guidance
        if (price_max > 50000) {
            result.valid = true;
            result.warning = 'Meesho typically caters to value-conscious customers. Products above ₹50,000 may have lower demand. Worth confirming with the caller.';
        }

        result.valid = true;
        result.price_min = price_min;
        result.price_max = price_max;
        return result;
    }
});

// ─── Listing Date Normalization Tool ──────────────────────────────────────────

export const normalizeListingDateTool = tool({
    name: 'normalize_listing_date',
    description: 'Converts relative time (today, tomorrow, next week) to YYYY-MM-DD. Use this when user says when they can start listing.',
    parameters: z.object({
        spoken_date: z.string().describe('What the user said about timing'),
        current_date_iso: z.string().describe('The reference current date in YYYY-MM-DD format')
    }),
    execute: async ({ spoken_date, current_date_iso }) => {
        const now = new Date(current_date_iso);
        const input = spoken_date.toLowerCase();
        let target = new Date(now);

        if (input.includes('today') || input.includes('aaj') || input.includes('thodi der')) {
            // Keep current date
        } else if (input.includes('tomorrow') || input.includes('kal')) {
            target.setDate(now.getDate() + 1);
        } else if (input.includes('after') || input.includes('ke baad')) {
            const match = input.match(/(\d+)/);
            if (match) {
                target.setDate(now.getDate() + parseInt(match[1]));
            } else if (input.includes('parso')) {
                target.setDate(now.getDate() + 2);
            }
        } else if (input.includes('week') || input.includes('hapte')) {
            target.setDate(now.getDate() + 7);
        } else if (input.includes('month') || input.includes('mahine')) {
            target.setMonth(now.getMonth() + 1);
        } else {
            // Check if it's already a date-like thing: "12th Jan", "25 March", etc.
            const dateMatch = input.match(/(\d{1,2})[th|st|nd|rd]?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
            if (dateMatch) {
                const parsed = new Date(`${dateMatch[1]} ${dateMatch[2]} 2026`);
                if (!isNaN(parsed)) {
                    target = parsed;
                } else {
                    return { valid: false, error: "Could not identify a listing start date." };
                }
            } else {
                return { valid: false, error: "Could not identify a listing start date." };
            }
        }

        // Return in DD/Month/YYYY format as requested
        const day = target.getDate().toString().padStart(2, '0');
        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const month = monthNames[target.getMonth()];
        const year = target.getFullYear();
        const formattedDate = `${day}/${month}/${year}`;

        return {
            valid: true,
            normalized: formattedDate,
            readable: target.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        };
    }
});
