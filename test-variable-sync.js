
// Mock session to test filtering logic
const session = {
    caller_phone: '+1234567890',
    name_spoken: 'Test Seller',
    price_min: 0,
    price_max: 100,
    pitch_delivered: 'yes',
    interest_in_meesho: 'yes',
    products_sold: ['items'],
    email: '',
    raw_email: 'test@meesho.com'
};

const filterSession = (sess) => {
    return Object.fromEntries(
        Object.entries(sess).filter(([k, v]) =>
            k !== 'caller_phone' &&
            v !== '' &&
            v !== null &&
            (typeof v === 'number' || (Array.isArray(v) ? v.length > 0 : !!v))
        )
    );
};

const filtered = filterSession(session);
console.log('--- Filtering Test ---');
console.log('Original session fields:', Object.keys(session).length);
console.log('Filtered session fields:', Object.keys(filtered).length);
console.log('Is price_min (0) present?', 'price_min' in filtered);
console.log('Is empty email present?', 'email' in filtered);
console.log('Is products_sold present?', 'products_sold' in filtered);

if (filtered.price_min === 0) {
    console.log('SUCCESS: price_min (0) was preserved.');
} else {
    console.log('FAILURE: price_min (0) was filtered out!');
}

if (!('email' in filtered)) {
    console.log('SUCCESS: Empty email was correctly filtered out.');
} else {
    console.log('FAILURE: Empty email was preserved!');
}
