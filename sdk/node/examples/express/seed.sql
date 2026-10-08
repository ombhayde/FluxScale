-- Disposable demo data only. Each application replica connects to this shared database.
BEGIN;
CREATE TABLE categories (id integer PRIMARY KEY, name text NOT NULL);
CREATE TABLE products (id integer PRIMARY KEY, category_id integer REFERENCES categories, name text NOT NULL, price_cents integer NOT NULL);
CREATE TABLE customers (id integer PRIMARY KEY, region text NOT NULL);
CREATE TABLE orders (id integer PRIMARY KEY, customer_id integer REFERENCES customers);
CREATE TABLE order_items (order_id integer REFERENCES orders, product_id integer REFERENCES products, quantity integer NOT NULL);
CREATE TABLE benchmark_counters (id integer PRIMARY KEY, value bigint NOT NULL DEFAULT 0);
INSERT INTO categories SELECT g,'category-'||g FROM generate_series(1,20) g;
INSERT INTO products SELECT g,(g%20)+1,'product-'||g,100+(g%10000) FROM generate_series(1,1000) g;
INSERT INTO customers SELECT g,'region-'||(g%10) FROM generate_series(1,2000) g;
INSERT INTO orders SELECT g,(g%2000)+1 FROM generate_series(1,12000) g;
INSERT INTO order_items SELECT o,(o*7+i)%1000+1,1+(i%4) FROM generate_series(1,12000) o CROSS JOIN generate_series(1,5) i;
INSERT INTO benchmark_counters SELECT g,0 FROM generate_series(1,1000) g;
CREATE INDEX ON orders(customer_id);
CREATE INDEX ON order_items(order_id);
ANALYZE;
COMMIT;
