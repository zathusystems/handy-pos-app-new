# MRA Product Codes - Official vs Placeholder

## Current Status

The product codes in the system are **PLACEHOLDER/EXAMPLE CODES** created for demonstration purposes. They are **NOT official MRA product codes**.

## Official MRA Product Codes

To get the **official MRA product codes**, you need to:

### Option 1: Fetch from MRA API (Recommended)

The MRA EIS API provides an endpoint to fetch official product codes:

```bash
# Get official MRA product codes from MRA API
curl -X GET https://api.mra.gov.mw/eis/product-codes/ \
  -H "Authorization: Bearer YOUR_MRA_TOKEN"
```

**Response format:**
```json
[
  {
    "code": "BEVERAGE-001",
    "name": "Soft Drink",
    "category": "Beverages",
    "tax_type": "standard",
    "tax_rate": 16.5
  },
  ...
]
```

### Option 2: Contact MRA Directly

1. **Email**: eis@mra.gov.mw
2. **Phone**: +265 1 770 600
3. **Website**: https://www.mra.gov.mw/eis
4. **Request**: Ask for the official product code list (CSV or JSON)

### Option 3: Use MRA Documentation

The official MRA EIS API documentation includes:
- Complete product code list
- Tax classifications
- Unit of measure standards
- Category mappings

**Documentation**: https://mra.gov.mw/eis/api/docs

---

## How to Update Product Codes

### Step 1: Get Official Codes from MRA

Contact MRA and request the official product code list in JSON format.

### Step 2: Update Backend Configuration

Create a new file: `/backend/mra_eis/product_codes.json`

```json
[
  {
    "code": "BEVERAGE-001",
    "name": "Soft Drink",
    "category": "Beverages",
    "default_tax_type": "standard",
    "default_tax_rate": 16.5
  },
  {
    "code": "BEVERAGE-002",
    "name": "Juice",
    "category": "Beverages",
    "default_tax_type": "standard",
    "default_tax_rate": 16.5
  }
  ...
]
```

### Step 3: Update the View

Edit `/backend/mra_eis/views.py`:

```python
import json
from pathlib import Path

class MRAProductCodesView(APIView):
    """
    API endpoint for fetching available MRA product codes.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        """
        Get available MRA product codes from official MRA list.
        """
        # Load from official MRA product codes file
        product_codes_file = Path(__file__).parent / 'product_codes.json'
        
        try:
            with open(product_codes_file, 'r') as f:
                mra_products = json.load(f)
        except FileNotFoundError:
            return Response(
                {'error': 'MRA product codes not configured'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE
            )

        # Filter by search query if provided
        search_query = request.query_params.get('search', '').lower()
        if search_query:
            mra_products = [
                p for p in mra_products
                if search_query in p['code'].lower() or search_query in p['name'].lower()
            ]

        return Response(mra_products, status=status.HTTP_200_OK)
```

### Step 4: Fetch from MRA API (Alternative)

If you want to fetch directly from MRA API:

```python
class MRAProductCodesView(APIView):
    """
    API endpoint for fetching available MRA product codes from MRA API.
    """
    permission_classes = [IsAuthenticated]

    def get(self, request):
        """
        Get available MRA product codes from MRA API.
        """
        try:
            # Fetch from MRA API
            response = requests.get(
                f"{settings.MRA_EIS_API_URL}/product-codes/",
                headers={'Authorization': f'Bearer {settings.MRA_EIS_API_TOKEN}'},
                timeout=10
            )
            response.raise_for_status()
            
            mra_products = response.json()
            
            # Filter by search query if provided
            search_query = request.query_params.get('search', '').lower()
            if search_query:
                mra_products = [
                    p for p in mra_products
                    if search_query in p['code'].lower() or search_query in p['name'].lower()
                ]
            
            return Response(mra_products, status=status.HTTP_200_OK)
            
        except requests.RequestException as e:
            return Response(
                {'error': f'Failed to fetch product codes from MRA: {str(e)}'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE
            )
```

---

## Current Placeholder Codes

The system currently includes these **PLACEHOLDER** codes for testing:

### Beverages
- BEVERAGE-001: Soft Drink (16.5%)
- BEVERAGE-002: Juice (16.5%)
- BEVERAGE-003: Water (0%)
- BEVERAGE-004: Alcoholic Beverage (16.5%)
- BEVERAGE-005: Coffee (16.5%)
- BEVERAGE-006: Tea (16.5%)

### Food
- FOOD-001: Bread (0%)
- FOOD-002: Milk (0%)
- FOOD-003: Meat (0%)
- FOOD-004: Vegetables (0%)
- FOOD-005: Fruits (0%)
- FOOD-006: Prepared Meal (16.5%)
- FOOD-007: Snacks (16.5%)

### Pharmacy
- PHARMA-001: Medicine (0%)
- PHARMA-002: Vitamin (0%)
- PHARMA-003: Medical Device (0%)

### Fuel
- FUEL-001: Petrol (16.5%)
- FUEL-002: Diesel (16.5%)
- FUEL-003: Kerosene (16.5%)

### Services
- SERVICE-001: Haircut (16.5%)
- SERVICE-002: Repair Service (16.5%)
- SERVICE-003: Consultation (16.5%)
- SERVICE-004: Delivery (16.5%)

### Retail
- RETAIL-001: Clothing (16.5%)
- RETAIL-002: Electronics (16.5%)
- RETAIL-003: Household Items (16.5%)

---

## ⚠️ Important Notes

### Before Going to Production

1. **DO NOT use placeholder codes in production**
2. **Contact MRA** to get official product codes
3. **Update the product_codes.json** with official codes
4. **Test thoroughly** with official codes
5. **Verify tax rates** match MRA requirements

### Tax Rates

The placeholder codes use these tax rates:
- **Standard**: 16.5% (most products)
- **Zero**: 0% (food, medicine, etc.)
- **Exempt**: 0% (services, certain items)

**Verify these match MRA requirements** before production.

### Compliance

Using placeholder codes may cause:
- ❌ MRA certification rejection
- ❌ Invoice rejection
- ❌ Audit failures
- ❌ Legal issues

---

## Next Steps

1. **Contact MRA** for official product codes
2. **Create product_codes.json** with official codes
3. **Update the view** to load from JSON or MRA API
4. **Test with official codes** in sandbox
5. **Deploy to production** with verified codes

---

## MRA Contact Information

- **Email**: eis@mra.gov.mw
- **Phone**: +265 1 770 600
- **Website**: https://www.mra.gov.mw/eis
- **API Docs**: https://mra.gov.mw/eis/api/docs
- **Support**: https://mra.gov.mw/support

---

## Summary

| Aspect | Current | Required |
|--------|---------|----------|
| Product Codes | Placeholder | Official from MRA |
| Tax Rates | Example | MRA-verified |
| Status | Development | Production-ready |
| Compliance | ❌ No | ✅ Yes |

**Action Required**: Contact MRA to get official product codes before going to production.
