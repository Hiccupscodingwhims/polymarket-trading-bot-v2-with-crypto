import { readFile } from 'fs/promises';

async function generateRegex() {
    try {
        // Load the JSON file using ESM-compatible methods
        const data = JSON.parse(
            await readFile(new URL('./sports-prevention2.json', import.meta.url))
        );

        // 1. Extract unique abbreviations and filter out nulls
        const abbreviations = [...new Set(data.map(item => item.league).filter(Boolean))];

        // 2. Escape any potential special characters
        const escapedAbbrs = abbreviations.map(str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

        // 3. Create the regex object
        const dynamicAbbrRegex = new RegExp(`(?:^|-)(?:${escapedAbbrs.join('|')})(?:-|$)`);

        console.log("Successfully generated regex:");
        console.log(dynamicAbbrRegex);

        return dynamicAbbrRegex;
    } catch (err) {
        console.error("Error processing abbreviations:", err.message);
    }
}

generateRegex();