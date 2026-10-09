import { createPool } from "mysql2/promise";
export const conn = createPool({
    connectionLimit: 10,
    host: 'project-final-axially-e907.k.aivencloud.com',
    port: 28130,
    user: 'avnadmin',
    password: 'AVNS_hSEZIEhrV0i0s-hcQyh',
    database: 'rider',
});

