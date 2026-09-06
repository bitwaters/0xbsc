UPDATE signals
SET decision_json = json_set(
      decision_json,
      '$.marketEntryPriceUsd',
      COALESCE(
        json_extract(decision_json, '$.presentation.priceUsd'),
        json_extract(decision_json, '$.features.priceUsd')
      ),
      '$.marketEntryAtMs',
      telegram_confirmed_at_ms
    )
WHERE delivery_state = 'SENT'
  AND telegram_confirmed_at_ms IS NOT NULL
  AND json_extract(decision_json, '$.marketEntryPriceUsd') IS NULL
  AND COALESCE(
    json_extract(decision_json, '$.presentation.priceUsd'),
    json_extract(decision_json, '$.features.priceUsd')
  ) IS NOT NULL;
