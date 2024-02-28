const axios = require('axios');

// This function makes a POST request to get the JSON of all
// items currently on the market. It returns a list with a JSON
// object for each item
const get_market_items_json = async () => {
    return await axios.post(`https://voxiom.io/market/public`, {} ,{
        headers: {
            'User-Agent': '=)',
        }
    })
    .then( (response) => {
        if (!response.data.success) throw new Error(`Reponse for market data not sucessfull.`);

        return response.data.data.market_items;
    })
    .catch( (error) => {
        console.log("Error getting market items:");
        throw error;
    });
}

// This function is used to attach the average price information to each JSON object
// representing the items in the market. We make a call to get_average_price() for each unqiue
// item type within the market and the average for that item is returned and attached to the JSON
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

        await delay(10);
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
        
        //console.log(`Getting avg price info for ${JSON.stringify(response.data.data.item_info.seller_name)}`);

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
        const {seller_name, ...item_without_seller} = item;

        if (!(seller_name in market_items_by_seller)) {
            market_items_by_seller[`${seller_name}`] = [];
        }

        market_items_by_seller[`${seller_name}`].push(item_without_seller);
    }
    
    return market_items_by_seller;
}



get_market_items_json()
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
