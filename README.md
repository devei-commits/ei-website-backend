# ei-website-backend

1. 
```bash
cp .env.example .env
```
2. 

Start PostgreSQL and the Node.js application:

```bash
docker-compose up --build
```
1


<!-- //       npm run zoho:import:customers-to-users -- --limit=10
// npm run zoho:import:vendors-to-vendor-clients -- --limit=10
// npm run zoho:import:salesorders -- --limit=10
// npm run zoho:pull-items -- --limit=10
// npm run zoho:export:items -- --limit=10 --out exports/sample.json
// set ZOHO_PULL_LIMIT=10 && npm run zoho:export:all -->


zoho:pull-items → fetches Zoho items and pushes them into your local products data.
zoho:seed-upload-patch → uploads seed data to Zoho and patches your local seed file/state.
zoho:seed-upload-patch:force → same as above, but forces re-upload even if already uploaded.
zoho:export:* scripts → pull specific Zoho modules and export them locally:
items, contacts, customers, vendors, invoices, salesorders, estimates, bills, purchaseorders
zoho:import:customers-to-users → imports Zoho customers into your app’s users table/model.
zoho:import:vendors-to-vendor-clients → imports Zoho vendors into vendor clients.
zoho:import:salesorders → imports Zoho sales orders into your app’s sales order records.
zoho:export:all → runs a combined export flow to pull all supported Zoho datasets at once.



{
			"item_id": "1252231000000935952",
			"name": "(150ML MEDMANOR WHITE BOTTLE) 445mm x 175mm x 180mm 5PLY 120 GSM WITH PARTITION 5X6 OF 100GSM",
			"item_name": "(150ML MEDMANOR WHITE BOTTLE) 445mm x 175mm x 180mm 5PLY 120 GSM WITH PARTITION 5X6 OF 100GSM",
			"category_id": "",
			"category_name": "",
			"unit": "NOS",
			"status": "active",
			"source": "csv",
			"is_combo_product": false,
			"is_linked_with_zohocrm": false,
			"zcrm_product_id": "",
			"description": "",
			"brand": "",
			"manufacturer": "",
			"rate": 37.5,
			"tax_id": "",
			"item_tax_preferences": [
				{
					"tax_specification": "intra",
					"tax_specific_type": "tax",
					"is_non_advol_tax": false,
					"tax_name_formatted": "GST18 [18%]",
					"tax_type": 2,
					"tax_groups_details": [],
					"tax_name": "GST18",
					"tax_percentage": 18,
					"tax_id": "1252231000000016155",
					"new_tax_type": "tax_group"
				},
				{
					"tax_specification": "inter",
					"tax_specific_type": "igst",
					"is_non_advol_tax": false,
					"tax_name_formatted": "IGST18 [18%]",
					"tax_type": 0,
					"tax_groups_details": [],
					"tax_name": "IGST18",
					"tax_percentage": 18,
					"tax_id": "1252231000000016071",
					"new_tax_type": "tax"
				}
			],
			"tax_name": "",
			"tax_percentage": 0,
			"purchase_account_id": "1252231000000000567",
			"purchase_account_name": "Cost of Goods Sold",
			"account_id": "1252231000000000486",
			"account_name": "Sales",
			"purchase_description": "",
			"purchase_rate": 37.5,
			"can_be_sold": true,
			"can_be_purchased": true,
			"track_inventory": true,
			"item_type": "inventory",
			"product_type": "goods",
			"is_taxable": true,
			"tax_exemption_id": "",
			"tax_exemption_code": "",
			"stock_on_hand": 0,
			"has_attachment": false,
			"is_returnable": true,
			"available_stock": 0,
			"actual_available_stock": 0,
			"sku": "5P00006",
			"upc": "",
			"ean": "",
			"isbn": "",
			"part_number": "",
			"track_batch_number": false,
			"is_storage_location_enabled": false,
			"reorder_level": "",
			"image_name": "",
			"image_type": "",
			"image_document_id": "",
			"created_time": "2023-04-08T14:58:59+0530",
			"last_modified_time": "2025-05-06T12:44:26+0530",
			"hsn_or_sac": "",
			"product_subtype": "",
			"purpose_of_use": "",
			"cf_category": "SPM - OTHERS",
			"cf_category_unformatted": "SPM - OTHERS",
			"cf_material_code": "150ML MEDMANOR WHITE BOTTLE",
			"cf_material_code_unformatted": "150ML MEDMANOR WHITE BOTTLE",
			"cf_previous_sku": "EI/CFB/22",
			"cf_previous_sku_unformatted": "EI/CFB/22",
			"length": "",
			"width": "",
			"height": "",
			"weight": "",
			"weight_unit": "kg",
			"dimension_unit": "cm",
			"dimensions_with_unit": "",
			"weight_with_unit": "",
			"tax_category_code": "",
			"tax_category_name": "",
			"tags": [],
			"product_tax_category": {
				"tax_category_code": "",
				"tax_category_name": "",
				"description": ""
			}
		}