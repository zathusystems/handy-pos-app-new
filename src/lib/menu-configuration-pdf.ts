export type MenuConfigurationExportRow = Record<string, unknown>;

export interface MenuConfigurationExport {
  business_name?: string;
  branch_name?: string;
  rows?: MenuConfigurationExportRow[];
}

type StockConnection = {
  name: string;
  unit: string;
  quantity: string;
};

type ChoiceSummary = {
  name: string;
  visible: boolean | null;
  overridden: boolean | null;
  priceMode: string;
  price: string;
  directStock?: StockConnection;
  recipe: StockConnection[];
};

type ChoiceSetSummary = {
  name: string;
  type: string;
  required: boolean | null;
  minimum: string;
  maximum: string;
  shared: boolean | null;
  sourceMenuItem: string;
  choices: Map<string, ChoiceSummary>;
};

type MenuItemSummary = {
  id: string;
  name: string;
  category: string;
  price: string;
  visible: boolean | null;
  source: string;
  recipe: StockConnection[];
  choiceSets: Map<string, ChoiceSetSummary>;
};

const text = (value: unknown): string => String(value ?? '').trim();

const escapeHtml = (value: unknown): string => text(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const asBoolean = (value: unknown): boolean | null => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
};

const filenamePart = (value: unknown, fallback: string): string => {
  const normalized = text(value)
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
};

const addUniqueConnection = (connections: StockConnection[], connection: StockConnection): void => {
  if (!connection.name && !connection.quantity && !connection.unit) return;
  const key = `${connection.name}|${connection.quantity}|${connection.unit}`;
  if (!connections.some((item) => `${item.name}|${item.quantity}|${item.unit}` === key)) {
    connections.push(connection);
  }
};

const summarizeRows = (rows: MenuConfigurationExportRow[]): MenuItemSummary[] => {
  const items = new Map<string, MenuItemSummary>();

  rows.forEach((row, index) => {
    const id = text(row.menu_item_id) || `menu-row-${index}`;
    let item = items.get(id);
    if (!item) {
      item = {
        id,
        name: text(row.menu_item) || 'Unnamed menu item',
        category: text(row.menu_category),
        price: text(row.menu_price),
        visible: asBoolean(row.menu_item_visible),
        source: text(row.menu_item_source),
        recipe: [],
        choiceSets: new Map(),
      };
      items.set(id, item);
    }

    addUniqueConnection(item.recipe, {
      name: text(row.menu_recipe_ingredient),
      unit: text(row.menu_recipe_unit),
      quantity: text(row.menu_recipe_quantity),
    });

    const setName = text(row.choice_set);
    if (!setName) return;

    let choiceSet = item.choiceSets.get(setName);
    if (!choiceSet) {
      choiceSet = {
        name: setName,
        type: text(row.choice_set_type),
        required: asBoolean(row.choice_set_required),
        minimum: text(row.choice_set_minimum),
        maximum: text(row.choice_set_maximum),
        shared: asBoolean(row.choice_set_shared),
        sourceMenuItem: text(row.choice_source_menu_item),
        choices: new Map(),
      };
      item.choiceSets.set(setName, choiceSet);
    }

    const choiceName = text(row.choice_name);
    if (!choiceName) return;
    let choice = choiceSet.choices.get(choiceName);
    if (!choice) {
      choice = {
        name: choiceName,
        visible: asBoolean(row.choice_visible),
        overridden: asBoolean(row.choice_is_item_override),
        priceMode: text(row.choice_price_mode),
        price: text(row.choice_price),
        recipe: [],
      };
      choiceSet.choices.set(choiceName, choice);
    }

    const directStockName = text(row.option_stock_item);
    if (directStockName || text(row.option_stock_quantity) || text(row.option_stock_unit)) {
      choice.directStock = {
        name: directStockName || 'Linked inventory item',
        unit: text(row.option_stock_unit),
        quantity: text(row.option_stock_quantity),
      };
    }
    addUniqueConnection(choice.recipe, {
      name: text(row.choice_recipe_ingredient),
      unit: text(row.choice_recipe_unit),
      quantity: text(row.choice_recipe_quantity),
    });
  });

  return Array.from(items.values());
};

const status = (value: boolean | null, positive: string, negative: string): string => {
  if (value === null) return '';
  return `<span class="status ${value ? 'positive' : 'negative'}">${value ? positive : negative}</span>`;
};

const connectionTable = (connections: StockConnection[], emptyText: string): string => {
  if (!connections.length) {
    return `<p class="empty">${escapeHtml(emptyText)}</p>`;
  }
  return `
    <table>
      <thead><tr><th>Inventory item</th><th class="quantity">Quantity used</th><th class="unit">Unit</th></tr></thead>
      <tbody>
        ${connections.map((connection) => `
          <tr>
            <td>${escapeHtml(connection.name)}</td>
            <td class="quantity">${escapeHtml(connection.quantity)}</td>
            <td class="unit">${escapeHtml(connection.unit)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
};

const choiceSetHtml = (choiceSet: ChoiceSetSummary): string => {
  const selectionRule = [
    choiceSet.required ? 'Required' : 'Optional',
    choiceSet.minimum || choiceSet.maximum
      ? `Choose ${escapeHtml(choiceSet.minimum || '0')}-${escapeHtml(choiceSet.maximum || '0')}`
      : '',
    choiceSet.shared ? 'Reusable choice set' : 'Item-specific choice set',
  ].filter(Boolean).join(' | ');

  const choices = Array.from(choiceSet.choices.values());
  return `
    <section class="choice-set">
      <div class="choice-set-header">
        <div>
          <h3>${escapeHtml(choiceSet.name)}</h3>
          <p>${escapeHtml(choiceSet.type || 'Choice')} | ${selectionRule}</p>
          ${choiceSet.shared && choiceSet.sourceMenuItem
            ? `<p class="muted">Source item: ${escapeHtml(choiceSet.sourceMenuItem)}</p>`
            : ''}
        </div>
      </div>
      ${choices.length ? choices.map((choice) => `
        <article class="choice">
          <div class="choice-title">
            <strong>${escapeHtml(choice.name)}</strong>
            <span>${status(choice.visible, 'Visible', 'Hidden')} ${choice.overridden ? status(true, 'Custom for this item', '') : ''}</span>
          </div>
          <p class="choice-price">Price: ${escapeHtml(choice.priceMode === 'override' ? 'Overrides meal price' : 'Adds to meal price')}${choice.price ? ` (${escapeHtml(choice.price)})` : ''}</p>
          ${choice.directStock ? `
            <div class="direct-stock"><strong>Direct stock deduction:</strong> ${escapeHtml(choice.directStock.quantity)} ${escapeHtml(choice.directStock.unit)} of ${escapeHtml(choice.directStock.name)}</div>
          ` : ''}
          <div class="choice-recipe">
            <div class="subheading">Choice recipe ingredients</div>
            ${connectionTable(choice.recipe, choice.directStock ? 'No additional recipe ingredients.' : 'No stock connection configured for this choice.')}
          </div>
        </article>
      `).join('') : '<p class="empty">No choices have been added to this set.</p>'}
    </section>
  `;
};

const buildPdfHtml = (data: MenuConfigurationExport): string => {
  const items = summarizeRows(Array.isArray(data.rows) ? data.rows : []);
  const generatedAt = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Menu Configuration Report</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 28px; background: #fff; color: #111827; font-family: Arial, Helvetica, sans-serif; font-size: 11px; line-height: 1.42; }
          .report { max-width: 850px; margin: 0 auto; }
          header { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 16px; border-bottom: 2px solid #111827; }
          .business-name { font-size: 23px; font-weight: 800; text-transform: uppercase; }
          .branch { margin-top: 4px; color: #4b5563; }
          .document { text-align: right; }
          .document h1 { margin: 0; font-size: 22px; letter-spacing: .03em; }
          .document p { margin: 4px 0 0; color: #4b5563; }
          .notice { margin: 18px 0; padding: 11px 13px; border: 1px solid #bfdbfe; background: #eff6ff; color: #1e3a8a; }
          .menu-item { margin-top: 18px; border: 1px solid #9ca3af; page-break-inside: avoid; break-inside: avoid; }
          .menu-header { display: flex; justify-content: space-between; gap: 16px; padding: 13px 15px; background: #f3f4f6; border-bottom: 1px solid #9ca3af; }
          .menu-header h2 { margin: 0; font-size: 16px; }
          .menu-meta { margin-top: 4px; color: #4b5563; }
          .price { text-align: right; font-size: 14px; font-weight: 700; }
          .source { margin-top: 4px; color: #4b5563; font-size: 10px; }
          .section { padding: 13px 15px; border-bottom: 1px solid #e5e7eb; }
          .section:last-child { border-bottom: 0; }
          .section h3 { margin: 0 0 8px; font-size: 13px; }
          table { width: 100%; border-collapse: collapse; }
          th { padding: 7px 8px; background: #f9fafb; border-top: 1px solid #d1d5db; border-bottom: 1px solid #d1d5db; text-align: left; font-size: 10px; }
          td { padding: 7px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
          .quantity, .unit { text-align: right; white-space: nowrap; }
          .empty { margin: 0; color: #6b7280; font-style: italic; }
          .choice-set { padding: 12px 0 0; }
          .choice-set + .choice-set { margin-top: 14px; border-top: 1px solid #d1d5db; }
          .choice-set-header h3 { margin: 0; font-size: 13px; }
          .choice-set-header p { margin: 3px 0 0; color: #4b5563; }
          .muted { color: #6b7280 !important; }
          .choice { margin-top: 9px; padding: 10px; border: 1px solid #d1d5db; background: #fff; }
          .choice-title { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
          .choice-title strong { font-size: 12px; }
          .choice-price { margin: 4px 0 8px; color: #374151; }
          .direct-stock { margin: 8px 0; padding: 7px 8px; background: #ecfdf5; border-left: 3px solid #059669; }
          .subheading { margin: 9px 0 5px; font-size: 10px; color: #4b5563; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
          .status { display: inline-block; margin-left: 4px; padding: 2px 5px; border-radius: 3px; font-size: 9px; font-weight: 700; white-space: nowrap; }
          .positive { background: #dcfce7; color: #166534; }
          .negative { background: #fee2e2; color: #991b1b; }
          footer { margin-top: 20px; border-top: 1px solid #d1d5db; padding-top: 10px; color: #6b7280; font-size: 10px; }
          @media print { body { padding: 0; } .report { max-width: none; } }
        </style>
      </head>
      <body>
        <main class="report">
          <header>
            <div>
              <div class="business-name">${escapeHtml(data.business_name || 'Business')}</div>
              <div class="branch">Branch: ${escapeHtml(data.branch_name || 'Current branch')}</div>
            </div>
            <div class="document">
              <h1>MENU CONFIGURATION</h1>
              <p>Generated ${escapeHtml(generatedAt)}</p>
            </div>
          </header>
          <div class="notice">This report shows how menu items, ingredients, units, quantities, choice sets, and choice stock deductions are currently configured. Hidden items and choices are included for troubleshooting.</div>
          ${items.length ? items.map((item) => `
            <article class="menu-item">
              <div class="menu-header">
                <div>
                  <h2>${escapeHtml(item.name)} ${status(item.visible, 'Visible', 'Hidden')}</h2>
                  <div class="menu-meta">${escapeHtml(item.category || 'Uncategorized')}</div>
                </div>
                <div class="price">${escapeHtml(item.price || '0')}<div class="source">${escapeHtml(item.source || 'Menu item')}</div></div>
              </div>
              <section class="section">
                <h3>Meal recipe</h3>
                ${connectionTable(item.recipe, 'No recipe ingredients are configured for this menu item.')}
              </section>
              <section class="section">
                <h3>Choice sets and stock connections</h3>
                ${item.choiceSets.size
                  ? Array.from(item.choiceSets.values()).map(choiceSetHtml).join('')
                  : '<p class="empty">No choice sets are configured for this menu item.</p>'}
              </section>
            </article>
          `).join('') : '<p class="empty">No menu items are configured for this branch.</p>'}
          <footer>Quantities are shown in the exact units configured on the connected inventory items. A choice with no stock connection does not deduct stock when selected.</footer>
        </main>
      </body>
    </html>
  `;
};

export async function downloadMenuConfigurationPdf(data: MenuConfigurationExport): Promise<void> {
  const html2pdfModule = await import('html2pdf.js');
  const html2pdf = ((html2pdfModule as any).default ?? html2pdfModule) as any;
  const container = document.createElement('div');
  container.innerHTML = buildPdfHtml(data);

  await html2pdf()
    .set({
      margin: 0.22,
      filename: `HandyPOS_Menu_Configuration_${filenamePart(data.branch_name, 'Branch')}.pdf`,
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] },
    })
    .from(container)
    .save();
}
