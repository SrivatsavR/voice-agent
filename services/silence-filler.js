/**
 * Silence Filler Phrases
 * 
 * A collection of warm, empathetic, and contextually appropriate phrases
 * for a Meesho onboarding specialist to use during moments of silence.
 * 
 * Mixes English and Hindi (Hinglish) to sound natural to Indian sellers.
 */

export const SILENCE_FILLER_PHRASES = [
  // English - Polite & Patient
  "Hello? Are you still there? I'm here whenever you're ready.",
  "Take your time, I'm listening.",
  "Just checking in to see if you can still hear me.",
  "I'm still on the line, no rush at all.",
  "Whenever you're ready, feel free to continue.",
  
  // Hinglish - Warm & Professional
  "Hello? Aap sun paa rahe hain? Main line par hi hoon.",
  "Koi baat nahi, aap aaram se bataiye. Main yahin hoon.",
  "Aap aaram se time lijiye, koi jaldi nahi hai. I'm waiting.",
  "Hello? Kya aap sun paa rahe hain? Main Meesho se bol raha hoon.",
  "Should I wait? Main line par hi hoon, aap jab ready hon tab bataiye.",
  "Aap sun paa rahe hain na? Just checking if we are still connected.",
  "Main yahin hoon, aap bilkul aaram se check kar lijiye."
];

/**
 * Gets a random silence filler phrase, optionally personalized with the caller's name.
 * 
 * @param {string} [name] - The name of the caller (e.g., "Rohit")
 * @returns {string} A natural sounding filler phrase
 */
export function getRandomFiller(name) {
  const phrase = SILENCE_FILLER_PHRASES[Math.floor(Math.random() * SILENCE_FILLER_PHRASES.length)];
  
  // If we have a name, occasionally prepend or append it with 'ji' for extra warmth
  if (name && Math.random() > 0.5) {
    const templates = [
      `${name} ji, ${phrase.toLowerCase()}`,
      `Hello ${name} ji? ${phrase}`,
      `${phrase} ${name} ji.`
    ];
    return templates[Math.floor(Math.random() * templates.length)];
  }
  
  return phrase;
}
