declare module "infobox-parser" {
  interface ParsedTemplate {
    general?: Record<string, string | number | boolean>;
    lists?: unknown[];
    tables: unknown[];
  }

  function InfoboxParser(content: string): ParsedTemplate;

  export default InfoboxParser;
}
