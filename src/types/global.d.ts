declare global {
    namespace NodeJS {
      interface Global {
        uiComponentStore: any;
        name: string;
        sodiumVersion: string;
        adminMenuItems: any[];
        regularMenuItems: any[];
      }
    }
  }
  
export {};