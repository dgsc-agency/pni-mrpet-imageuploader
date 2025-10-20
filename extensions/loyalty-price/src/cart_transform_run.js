// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const operations = [];

  // Check if customer has loyalty status
  const isCustomerLoyal = input.cart.buyerIdentity && 
                          input.cart.buyerIdentity.customer && 
                          input.cart.buyerIdentity.customer.metafield && 
                          input.cart.buyerIdentity.customer.metafield.value === "true";

  // Only apply loyalty pricing if customer is loyal
  if (isCustomerLoyal) {
    // Process each cart line item
    for (const line of input.cart.lines) {
      // Check if the merchandise is a ProductVariant and has metafield data
      if (line.merchandise && line.merchandise.metafield && line.merchandise.metafield.value) {
        try {
          // Parse the metafield JSON data
          const metafieldData = JSON.parse(line.merchandise.metafield.value);
          
          // Check if loyalty is true and promo_price exists
          if (metafieldData.loyalty === true && metafieldData.promo_price) {
            // Apply the promo_price
            operations.push({
              lineUpdate: {
                cartLineId: line.id,
                price: {
                  adjustment: {
                    fixedPricePerUnit: {
                      amount: metafieldData.promo_price.toString()
                    }
                  }
                }
              }
            });
          }
        } catch (error) {
          // If JSON parsing fails, skip this line item
          // Silent error handling
        }
      }
    }
  }

  return {
    operations: operations
  };
};