declare module "infobox-parser" {
  interface ParsedTemplate {
    type: "template" | "infobox";
    name?: string;
    data?: Record<string, string | number | boolean>;
  }

  function InfoboxParser(content: string): ParsedTemplate[];

  export default InfoboxParser;
}
