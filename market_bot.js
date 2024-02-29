const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const stealth_plugin = require('puppeteer-extra-plugin-stealth')

puppeteer.use(stealth_plugin())

// This function makes a POST request to get the JSON of all
// items currently on the market. It returns a list with a JSON
// object for each item
const get_market_items_json = async (market_items_data) => {
    return await axios.post(`https://voxiom.io/market/public`, {} ,{
        headers: {
            'User-Agent': '=)',
        }
    })
    .then( (response) => {
        if (!response.data.success) throw new Error(`Reponse for market data not sucessfull.`);
        market_items = response.data.data.market_items;
    
        for (let i = 0; i < market_items.length; i++) {
            const additional_item_data = market_items_data.get(i); 

            market_items[i].index = i;
            market_items[i].skin_name = additional_item_data[0];
            market_items[i].skin_rarity = additional_item_data[1];
        }

        return market_items;
    })
    .catch( (error) => {
        console.log("Error getting market items:");
        throw error;
    });
}

const attach_listing_metadata = (market_items) => {

}

// This function is used to attach the average price information to each JSON object
// representing the items in the market. We make a call to get_average_price() for each 
// item within the market and the average for that item is returned and attached to the JSON
// for that item. We return all of the market items with the new average as a member in the JSON
const attach_average_price_history = async (market_items) => {
    let edited_items = [];
    
    // We need a delay so we don't get rate limited by our POST requests
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)); 
    
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

// This function takes in an item_id and uses the previous market history available to calculate the
// average price for this item. This method is very susceptible to errors for items with a low frequency of trade
// or many outliers in the recent trade history
const get_average_price = async (item_id) => {

    return await axios.post(`https://voxiom.io/market/item_info`, {
        item_id: item_id,
    },
    {
        headers: {
            'User-Agent': '=)',
        }
    })
    .then( (response) => {
        if (!response.data.success) throw new Error(`Error with response for item.`);
        
        const sale_history = response.data.data.item_info.price_history;

        if (sale_history.length === 0) throw new Error(`No previous history for item ${item_id} to average.`);

        let sum = 0;

        for (const sale of sale_history) {
            sum += sale.price;
        }
        
        sum /= sale_history.length;
        
        const seller_name = response.data.data.item_info.seller_name

        return [sum, seller_name];

    })
    .catch( (error) => {
        console.log(error);
    });
}

// This function can be used to filter duplicate items of the same type,
// and this way the list of market_items will have unique item types for each item.
// Right now we are keeping the lowest price item if there are duplicates
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
    let market_items_by_seller = { };

    for (const item of market_items) {
        const {
            seller_name,
            price,
            average_price,
            index,
            skin_name,
            skin_rarity,
            ..._
        } = item;

        const item_info = {
            skin_name: skin_name,
            skin_rarity: skin_rarity,
            price: price,
            average_price: average_price,
            index: index,
        };

        if (!(seller_name in market_items_by_seller)) {
            market_items_by_seller[`${seller_name}`] = [];
        }

        market_items_by_seller[`${seller_name}`].push(item_info);
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

const run_bot = async () => {

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)); 
    
    let market_items_data = new Map();
    
    await puppeteer.launch({headless: true})
    .then(async headless_browser => {
        console.log(`Using headless browser to get data for market listings...`);
        
        const page = await headless_browser.newPage();
        await page.goto('https://voxiom.io/loadouts/market', {waitUntil: ['load', 'domcontentloaded']});
        
        // Initial delay to let page load JS
        await delay(5000);
        
        // Used to index the items to be matched later with pricing data
        let index = 0;
        
        // selector for the next page button
        const svg_selector = '.fa-angle-right';
        let is_next_page_available = false;

        do {

            const items = await page.$$(
                'div.bSIkxv'
            );

            for (const item of items) {
                const childDivs = await item.$$('div');
                
                const childDivTextList = await Promise.all(childDivs.map(async (childDiv) => {
                    return await childDiv.evaluate(div => div.innerText);
                }));

                market_items_data.set(index, childDivTextList.slice(-3));
                
                index++;
            }

            is_next_page_available = await check_if_next_page_available(page, svg_selector);
            
            if (is_next_page_available) {
                await page.click(svg_selector);
                await delay(1000);
            }

        } while (is_next_page_available);

        console.log(`\tDone.`);
        await headless_browser.close();
    });

    console.log(market_items_data);

    await get_market_items_json(market_items_data)
        .then( (initial_items) => {
            console.log(`Initial market item count: ${initial_items.length}`);
            return attach_average_price_history(initial_items);
        })
        .then( (updated_items) => {
            return filter_duplicate_items(updated_items);
        })
        .then( (unique_items) => {
            console.log(`Market unique item count: ${unique_items.length}`);
            return filter_invalid_items_by_price(unique_items);
        })
        .then( (valid_items) => {
            console.log(`Market valid item count: ${valid_items.length}`);
            return consolidate_items_by_seller(valid_items);
        })
        .then( (items_by_seller) => {
            console.log(items_by_seller);
        })
        .catch( (error) => {
            console.log(`\t${error.message}`);
        });
}

run_bot();
setInterval(async () => await run_bot(), 180000);
