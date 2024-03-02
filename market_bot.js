const FormData = require('form-data');
const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth')
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

puppeteer.use(stealth_plugin())

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)); 

const generate_random_string = (length) => {
  const buffer = crypto.randomBytes(length);
  return buffer.toString('hex');
};

const get_market_items_json = async (market_items_data) => {
    const user_agent_string = generate_random_string(Math.floor(Math.random() * 3));

    return await axios.post(`https://voxiom.io/market/public`, {} ,{
        headers: {
            'User-Agent': `${user_agent_string.slice(0)}=>${user_agent_string.slice(0,-1)}`,
        }
    })
    .then( (response) => {
        if (!response.data.success) throw new Error(`Reponse for market data not sucessfull.`);

        market_items = response.data.data.market_items;
    
        // Attach data gathered from headless browser to the json recieved from the post request
        for (let i = 0; i < market_items.length; i++) {
            if (market_items_data.has(i)) {
                const additional_item_data = market_items_data.get(i); 

                market_items[i].index = i;
                market_items[i].skin_name = additional_item_data.skin_name;
                market_items[i].skin_rarity = additional_item_data.skin_rarity;
                market_items[i].image = additional_item_data.image;
            }
        }

        return market_items;
    })
    .catch( (error) => {
        console.log(`Error getting market items:`);
        throw error;
    });
}

const attach_average_price_history = async (market_items) => {
    let edited_items = [];
    
    // For each item we make a post request for the items price history and seller name
    // and add the values to the item object
    for (const item of market_items) {
        const [average_price, seller_name] = await get_average_price(item.item_id);

        if (average_price) {
            item.average_price = average_price;
            item.seller_name = seller_name;

            edited_items.push(item);
        }

        await delay(25);
    }

    return edited_items;
}

const get_average_price = async (item_id) => {

    const user_agent_string = generate_random_string(Math.floor(Math.random() * 3));

    return await axios.post(`https://voxiom.io/market/item_info`, {
        item_id: item_id,
    },
    {
        headers: {
            'User-Agent': `${user_agent_string.slice(0)}=>${user_agent_string.slice(0,-1)}`,
        }
    })
    .then( (response) => {
        if (!response.data.success) throw new Error(`Error with response for item.`);
        
        const seller_name = response.data.data.item_info.seller_name

        const sale_history = response.data.data.item_info.price_history;

        if (sale_history.length === 0) throw new Error(`No previous history for item ${item_id} to average.`);

        // We need a more robust way of coming up with the market average due to outliers
        let sum = 0;

        for (const sale of sale_history) {
            sum += sale.price;
        }
        
        sum /= sale_history.length;
        

        return [sum, seller_name];

    })
    .catch( (error) => {
        console.log(error);
    });
}

const filter_duplicate_items = (market_items) => {
    const unique_items = new Map();

    for (item of market_items) {
        if (unique_items.has(item.item_type)) {
            const previous_item = unique_items.get(item.item_type) 

            if (item.price < previous_item.price) {
                unique_items.set(item.item_type, item);
            }

        } else {
            unique_items.set(item.item_type, item);
        }
    }

    return Array.from(unique_items.values());
}

const filter_invalid_items_by_price = (market_items) => {
    let valid_items = []

    for (item of market_items) {
        if (item.price <= item.average_price) {
            valid_items.push(item)
        }
    }

    return valid_items;
}

const consolidate_items_by_seller = (market_items) => {
    let market_items_by_seller = new Map();

    for (const item of market_items) {
        const {
            item_id,
            seller_name,
            price,
            average_price,
            index,
            skin_name,
            skin_rarity,
            image,
            ..._
        } = item;
        
        const item_info = {
            skin_name: skin_name,
            skin_rarity: skin_rarity,
            price: price,
            average_price: average_price,
            index: index,
            item_id: item_id,
            image: image,
        };

        if (!market_items_by_seller.has(seller_name)) {
            market_items_by_seller.set(seller_name, [item_info]); 
        } else {
            let existing_values = market_items_by_seller.get(seller_name);
            existing_values.push(item_info);
            market_items_by_seller.set(seller_name, existing_values);
        }

    }
    
    return market_items_by_seller;
}


const check_if_next_page_available = async (page, svg_selector) => {

    await page.waitForSelector(svg_selector);

    // Wait until the svg for the next page button shows up
    const svg_element = await page.$(svg_selector);

    if (svg_element) {

        const parent_div = await svg_element.evaluateHandle( svg => {
            return svg.parentElement;
        });

        const style_attribute = await parent_div.evaluate( div => {
            const computed_style = window.getComputedStyle(div);

            return computed_style.getPropertyValue('visibility')
        })

        if (style_attribute === 'visible') {
            return true;
        } else {
            return false;
        }

    } else {
        return false;
    }
}

const run_headless_browser_for_listing_metadata = async () => {
    let market_items_data = new Map();
    
    await puppeteer.launch({headless: true})
    .then(async headless_browser => {
        console.log(`- Using headless browser to get data for market listings...`);
        
        const page = await headless_browser.newPage();
        await page.goto('https://voxiom.io/loadouts/market', {waitUntil: ['load', 'domcontentloaded']});
        
        // Used to index the items to be matched later with pricing data
        let index = 0;
        
        // selector for the next page button
        const svg_selector = '.fa-angle-right';
        let is_next_page_available = false;

        const next_page_selector = 'div.bSIkxv';
        do {

            await page.waitForSelector(next_page_selector);
            await delay(30);
            
            // This divs direct children are the divs for each listing on the market
            const items = await page.$$(
                next_page_selector 
            );

            for (const item of items) {
                
                // This will get the text for all inner HTML of this div for the listing
                // From this text we will get the price, rarity, and skin name
                const child_divs = await item.$$('div');
                
                const child_div_text_list = await Promise.all(child_divs.map(async (child_div) => {
                    return await child_div.evaluate(div => div.innerText);
                }));

                // We can use this to get the data url for the image associated with the listing
                const child_imgs = await item.$$('img');

                const child_img_list = await Promise.all(child_imgs.map(async (child_img) => {
                    return await child_img.evaluate(img => img.src);
                }));

                // Put all relevant info for the listing into an object
                // There is redundant information so we only need the last 3 from the text list
                const l = child_div_text_list.length;

                const item_listing_info = {
                    price: child_div_text_list[l-1],
                    skin_rarity: child_div_text_list[l-2],
                    skin_name: child_div_text_list[l-3], 
                    image: child_img_list[0],
                };

                // Insert the object into the map of market items
                // data with the index of the listing as the key
                market_items_data.set(index++, item_listing_info);
                
            }

            // If the next page is available we want to click it and wait for the next
            // page of the market to load before repeating the process
            is_next_page_available = await check_if_next_page_available(page, svg_selector);
            
            console.log(`-- Processed ${index} listings so far..`);

            if (is_next_page_available) {
                console.log('--- Continuing to next page in market..');
                await page.click(svg_selector);
            }

        } while (is_next_page_available);

        console.log(`- Done. Closing headless browser.`);
        await headless_browser.close();
    });

    return market_items_data;

}

const get_items_to_send = (new_items, prev_items) => {
    const items_to_send = [];

    for ([key, values] of new_items) {
        const {
            item_id,
            price,
            ..._
        } = values;

        const item = {
            item_id: item_id,
            price: price,
            seller_name: key,
        };

        const item_string = JSON.stringify(item);

        if (!prev_items.has(item_string)) {
            items_to_send.push([key, values]);
            prev_items.add(item_string);            
        }
    }

    return items_to_send;
}

const send_discord_webhook = async (webhook, seller, data) => {

    const {
        item_id,
        price,
        average_price,
        index,
        skin_name,
        skin_rarity,
        image,
        ..._
    } = data[0];

    const rarity_colors = {
        Common: 0xFFFFFF,
        Noteworthy: 0x809CFF,
        Precious: 0xB463FF,
        Magnificent: 0xFF54E0,
        Extraordinary: 0xE67E22,
        Covert: 0xFF4265,
        Artifact: 0xFFE063,
    };

    // Generate a unique filename
    const filename = `temp_${Date.now()}.png`;
    const filePath = path.join(__dirname, filename);

    // Convert data URL to binary data
    const imageData = Buffer.from(image.split(',')[1], 'base64');

    // Write binary data to a temporary file
    fs.writeFileSync(filePath, imageData);

    try {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath), { filename });
        formData.append(
            'payload_json',
            JSON.stringify({
                content: '',
                    embeds: [
                    {
                        title: `${skin_name}`,
                        type: 'rich',
                        description: `${(average_price - price).toFixed(2)} gems less than the average.`,
                        url: 'https://voxiom.io/loadouts/market',
                        color: `${rarity_colors[skin_rarity]}`,
                        footer: {
                            text: `The item is being sold by: ${seller}.`,
                        },
                        thumbnail: {
                            url: `attachment://${filename}`,
                            width: 30,
                            height: 30,
                        },
                        fields: [
                            {
                                name: 'Average Price',
                                value: `${average_price.toFixed(2)}`,
                                inline: false,
                            },
                            {
                                name: 'Listed Price',
                                value: `${price}`,
                                inline: false,
                            },
                            {
                                name: 'Rarity',
                                value: `${skin_rarity}`,
                                inline: false,
                            },
                        ],
                    },
                ],
            })
        );

        // Send Discord webhook with the temporary file
        await axios.post(`${webhook}?username=Vox Market Bot`, formData, {
            headers: {
                ...formData.getHeaders(),
            },
        });

    } catch (error) {
        console.error(`Error: ${error.message}`);
    } finally {
        fs.unlinkSync(filePath);
    }
};

const send_items_to_discord_webhooks = async (webhooks, items_to_send) => {
    for ([seller, obj] of items_to_send) {
        
        for (webhook of webhooks) {
            await send_discord_webhook(webhook, seller, obj);
        }

        await delay(100);
    }
}

const run_scraper = async (prev_items) => {

    const market_items_metadata = await run_headless_browser_for_listing_metadata();

    const new_items = await get_market_items_json(market_items_metadata)
        .then( (initial_items) => {
            console.log(`\n\n- Total market item count: ${initial_items.length}.`);
            return attach_average_price_history(initial_items);
        })
        .then( (updated_items) => {
            console.log(`- Calculated average price for ${updated_items.length} listings.`);
            return filter_invalid_items_by_price(updated_items);
        })
        .then( (valid_items) => {
            console.log(`- Filtered out listings above average for price history.\n- ${valid_items.length} items found on market below average price.`);
            return consolidate_items_by_seller(valid_items);
        })
        .then( (items_by_seller) => {
            return items_by_seller;
        })
        .catch( (error) => {
            console.log(`\t${error.message}`);
            return undefined;
        });

    try {

        console.log(`\n- Comparing current market data to previous data collected...`);
        
        const items_to_send = get_items_to_send(new_items, prev_items);

        console.log(`- ${items_to_send.length} new listings since last check.`);
        
        console.log(`\n\n- Sending new items to discord server.`);

        const webhooks = [`https://discord.com/api/webhooks/1212966670772215808/NFnYCFmrycXerYUEikSEBs2SeXh0wdR7XTwKwE6qnrYIyNHXMYtOeaAAwO7cnzPd1Yht`]

        await send_items_to_discord_webhooks(webhooks, items_to_send);;

    } catch (error) {
        console.error(error.message);
    }
}


const bot_loop = () => {
    let current_iteration = 0;

    let start_time = process.hrtime.bigint();

    let prev_items = new Set();

    setInterval(async () => {
        await run_scraper(prev_items);
        console.log(`\n===================== ${++current_iteration} =====================\n`);

        if ( ((process.hrtime.bigint() - start_time) / BigInt(1000000000 * 60 * 60)) >= BigInt(6) ) { // reset the set every 6 hours
            prev_items.clear();
            start_time = process.hrtime.bigint();
        }

    }, 180000);
}

bot_loop();
