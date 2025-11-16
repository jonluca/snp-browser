declare module "infobox-parser" {
  interface ParsedTemplate {
    general?: Record<string, unknown>;
    lists?: unknown[];
    tables: unknown[];
  }

  function InfoboxParser(content: string): ParsedTemplate;

  export default InfoboxParser;
}
