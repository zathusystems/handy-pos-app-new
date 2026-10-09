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

export async function downloadMenuConfigurationPdf(data: MenuConfigurationExport): Promise<void> {
  const jsPdfModule = await import('jspdf');
  const JsPdf = (jsPdfModule as any).default ?? jsPdfModule.jsPDF;
  const pdf = new JsPdf({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const items = summarizeRows(Array.isArray(data.rows) ? data.rows : []);
  const margin = 14;
  const pageWidth = 210;
  const contentWidth = pageWidth - (margin * 2);
  const bottom = 282;
  let y = 14;

  const drawHeader = (continued = false) => {
    pdf.setTextColor(17, 24, 39);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(17);
    pdf.text(text(data.business_name || 'Business').toUpperCase(), margin, y);
    pdf.setFontSize(14);
    pdf.text(continued ? 'MENU CONFIGURATION (CONTINUED)' : 'MENU CONFIGURATION', pageWidth - margin, y, { align: 'right' });
    y += 6;
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(75, 85, 99);
    pdf.text(`Branch: ${text(data.branch_name || 'Current branch')}`, margin, y);
    pdf.text(`Generated: ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date())}`, pageWidth - margin, y, { align: 'right' });
    y += 4;
    pdf.setDrawColor(17, 24, 39);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 7;
  };

  const newPage = () => {
    pdf.addPage();
    y = 14;
    drawHeader(true);
  };

  const ensureSpace = (height: number) => {
    if (y + height > bottom) newPage();
  };

  const write = (
    value: string,
    options: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number; gapAfter?: number } = {},
  ) => {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    const lineHeight = size >= 13 ? 6.2 : size >= 11 ? 5.3 : 4.5;
    const lines = pdf.splitTextToSize(value, contentWidth - indent);
    ensureSpace((lines.length * lineHeight) + 2);
    pdf.setFont('helvetica', options.bold ? 'bold' : 'normal');
    pdf.setFontSize(size);
    pdf.setTextColor(...(options.color ?? [17, 24, 39]));
    pdf.text(lines, margin + indent, y);
    y += (lines.length * lineHeight) + (options.gapAfter ?? 1.5);
  };

  const divider = () => {
    ensureSpace(4);
    pdf.setDrawColor(209, 213, 219);
    pdf.line(margin, y, pageWidth - margin, y);
    y += 4;
  };

  const connectionText = (connection: StockConnection): string => {
    const quantity = [connection.quantity, connection.unit].filter(Boolean).join(' ');
    return `${quantity ? `${quantity} of ` : ''}${connection.name || 'Unnamed inventory item'}`;
  };

  drawHeader();
  write(
    'This report records the menu setup at the time it was downloaded. Hidden menu items and choices are included so configuration problems can be identified.',
    { size: 9, color: [30, 64, 175], gapAfter: 5 },
  );

  if (!items.length) {
    write('No menu items are configured for this branch.', { size: 11, color: [75, 85, 99] });
  }

  items.forEach((item) => {
    ensureSpace(18);
    divider();
    write(item.name, { size: 14, bold: true, gapAfter: 0.5 });
    const details = [
      item.category || 'Uncategorized',
      `Price: ${item.price || '0'}`,
      item.visible === null ? '' : item.visible ? 'Visible' : 'Hidden',
      item.source || 'Menu item',
    ].filter(Boolean).join(' | ');
    write(details, { size: 9, color: [75, 85, 99], gapAfter: 3 });

    write('Meal recipe', { size: 11, bold: true, gapAfter: 1 });
    if (item.recipe.length) {
      item.recipe.forEach((connection) => {
        write(`- ${connectionText(connection)}`, { size: 10, indent: 4, gapAfter: 0.8 });
      });
    } else {
      write('No recipe ingredients are configured for this menu item.', { size: 9, color: [107, 114, 128], indent: 4, gapAfter: 2 });
    }

    write('Choice sets and stock connections', { size: 11, bold: true, gapAfter: 1 });
    const choiceSets = Array.from(item.choiceSets.values());
    if (!choiceSets.length) {
      write('No choice sets are configured for this menu item.', { size: 9, color: [107, 114, 128], indent: 4, gapAfter: 2 });
    }

    choiceSets.forEach((choiceSet) => {
      const selectionRule = [
        choiceSet.required ? 'Required' : 'Optional',
        choiceSet.minimum || choiceSet.maximum ? `Choose ${choiceSet.minimum || '0'}-${choiceSet.maximum || '0'}` : '',
        choiceSet.shared ? 'Reusable' : 'Item-specific',
      ].filter(Boolean).join(' | ');
      write(`${choiceSet.name} (${choiceSet.type || 'Choice'})`, { size: 11, bold: true, indent: 4, gapAfter: 0.5 });
      write(selectionRule, { size: 9, color: [75, 85, 99], indent: 8, gapAfter: 0.5 });
      if (choiceSet.shared && choiceSet.sourceMenuItem) {
        write(`Source item: ${choiceSet.sourceMenuItem}`, { size: 9, color: [75, 85, 99], indent: 8, gapAfter: 0.5 });
      }

      const choices = Array.from(choiceSet.choices.values());
      if (!choices.length) {
        write('No choices have been added to this set.', { size: 9, color: [107, 114, 128], indent: 8, gapAfter: 1.5 });
      }

      choices.forEach((choice) => {
        const choiceStatus = [
          choice.visible === null ? '' : choice.visible ? 'Visible' : 'Hidden',
          choice.overridden ? 'Custom for this menu item' : '',
        ].filter(Boolean).join(' | ');
        write(`- ${choice.name}${choiceStatus ? ` (${choiceStatus})` : ''}`, { size: 10, bold: true, indent: 8, gapAfter: 0.5 });
        const priceLabel = choice.priceMode === 'override' ? 'Overrides meal price' : 'Adds to meal price';
        write(`Price: ${priceLabel}${choice.price ? ` (${choice.price})` : ''}`, { size: 9, indent: 12, gapAfter: 0.5 });
        if (choice.directStock) {
          write(`Direct stock deduction: ${connectionText(choice.directStock)}`, { size: 9, indent: 12, gapAfter: 0.5 });
        }
        if (choice.recipe.length) {
          write('Choice recipe ingredients:', { size: 9, bold: true, indent: 12, gapAfter: 0.4 });
          choice.recipe.forEach((connection) => {
            write(`- ${connectionText(connection)}`, { size: 9, indent: 16, gapAfter: 0.4 });
          });
        } else if (!choice.directStock) {
          write('No stock connection configured for this choice.', { size: 9, color: [107, 114, 128], indent: 12, gapAfter: 0.5 });
        }
      });
      y += 1.5;
    });
  });

  divider();
  write(
    'Quantities are shown in the exact units configured on the linked inventory items. A choice with no stock connection does not deduct stock when selected.',
    { size: 9, color: [107, 114, 128] },
  );
  pdf.save(`HandyPOS_Menu_Configuration_${filenamePart(data.branch_name, 'Branch')}.pdf`);
}
