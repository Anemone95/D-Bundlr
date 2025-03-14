export interface ModuleEvent {
    module: string|number;
    action: "GET" | "REQUIRE" | "CALL" | "SET" | "ERROR" | "NEW";
    value?: string;
}
