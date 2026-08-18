Import each file into the Google Sheet tab of the same name:
File > Import > Upload > Append to current sheet > Comma separator.

Products.csv     134 rows   moq + gst_rate are PLACEHOLDERS, replace before go-live
Variants.csv     280 rows   size variants, one row per parent SKU + size
PriceTiers.csv   536 rows   PLACEHOLDER tier ladder, replace with the real table
Categories.csv    17 rows

Users and Approvers are not seeded. Fill them by hand, then run
seedPasswords() and healthCheck() from the Apps Script editor.
